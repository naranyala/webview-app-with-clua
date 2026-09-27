/*
 * Webview-facing PDF bindings: open dialog, document identity, and the
 * background table-of-contents extraction.
 *
 * See include/pdf_session.h for the layer contract; the extraction and cache
 * logic itself lives in pdf_toc.c.
 */

#include "pdf_session.h"

#include "pdf_toc.h"

#include <gtk/gtk.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* Payload shipped to the extraction thread; freed by the worker. */
typedef struct {
    webview_t view;
    char *request_id;
    pdf_toc_request pdf;
    pdf_toc toc;
    GError *error;
} pdf_toc_task;

/* Response queued back onto the webview thread when the worker finishes. */
typedef struct {
    webview_t view;
    char *request_id;
    char *response;
} pdf_toc_response;

/* At most one extraction runs at a time (guarded atomically across threads). */
static gint active_pdf_toc_jobs = 0;

/* --- document validation ------------------------------------------------- */

/*
 * Accepts only regular files starting with the "%PDF-" magic, so a renamed
 * image or a directory never reaches the renderer. Reports the size when the
 * caller asks for it.
 */
static int is_valid_pdf(const char *path, long long *size) {
    struct stat file_info;
    char header[5];
    FILE *file;
    size_t read_count;

    if (path == NULL || stat(path, &file_info) != 0 || !S_ISREG(file_info.st_mode)) {
        return 0;
    }

    file = fopen(path, "rb");
    if (file == NULL) return 0;

    read_count = fread(header, 1, sizeof(header), file);
    fclose(file);

    if (read_count != sizeof(header) || memcmp(header, "%PDF-", sizeof(header)) != 0) {
        return 0;
    }

    if (size != NULL) *size = (long long)file_info.st_size;
    return 1;
}

/*
 * Stable identity for a document: SHA-256 over canonical path, size, and
 * mtime. It keys the TOC cache, so an edited file re-extracts automatically.
 */
static char *create_pdf_fingerprint(const char *path, long long size) {
    struct stat file_info;
    if (stat(path, &file_info) != 0) return NULL;
    char *canonical_path = g_canonicalize_filename(path, NULL);
    char *identity = g_strdup_printf("%s:%lld:%ld", canonical_path, size,
        (long)file_info.st_mtime);
    char *fingerprint = g_compute_checksum_for_data(G_CHECKSUM_SHA256,
        (const guchar *)identity, strlen(identity));
    g_free(identity);
    g_free(canonical_path);
    return fingerprint;
}

/* --- openPdf binding ----------------------------------------------------- */

/* GTK filter that limits the chooser to PDF documents. */
static const picker_filter pdf_picker_filter = {
    "PDF documents (*.pdf)",
    "*.pdf",
    "application/pdf",
};

/*
 * Runs on the GTK main loop after dispatch_picker(). Validates the choice,
 * builds a file:// URL (or an inline data URL for files up to 32 MiB), stores
 * the document identity on app_context, and answers the pending request.
 */
static void show_pdf_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected_path = run_path_chooser(view, PICKER_OPEN_FILE, "Open PDF", &pdf_picker_filter);
    long long size = 0;
    char *file_name = NULL;
    char *file_contents = NULL;
    gsize file_length = 0;
    char *fingerprint = NULL;
    char *data_url = NULL;
    char *escaped_name = NULL;
    char *escaped_url = NULL;
    char *url = NULL;
    char *response = NULL;
    size_t response_capacity;

    if (selected_path == NULL) {
        char canceled[] = "{\"canceled\":true}";
        webview_return(view, request->request_id, 0, canceled);
        goto cleanup;
    }

    if (!is_valid_pdf(selected_path, &size)) {
        return_native_error(view, request->request_id, "INVALID_PDF",
            "The selected file is not a readable PDF document.");
        goto cleanup;
    }

    url = calloc(PATH_MAX * 3 + 8, 1);
    if (url == NULL || !build_file_url(selected_path, url, (size_t)PATH_MAX * 3 + 8)) {
        return_native_error(view, request->request_id, "PDF_TOO_LARGE",
            "The selected PDF path is too long to open.");
        goto cleanup;
    }

    file_name = g_path_get_basename(selected_path);
    fingerprint = create_pdf_fingerprint(selected_path, size);
    if (fingerprint == NULL) {
        return_native_error(view, request->request_id, "INTERNAL_ERROR",
            "The selected PDF identity could not be prepared.");
        goto cleanup;
    }
    if (size <= 32LL * 1024LL * 1024LL &&
        g_file_get_contents(selected_path, &file_contents, &file_length, NULL)) {
        char *encoded = g_base64_encode((const guchar *)file_contents, file_length);
        if (encoded != NULL) {
            data_url = g_strdup_printf("data:application/pdf;base64,%s", encoded);
            g_free(encoded);
        }
    }
    response_capacity = (size_t)PATH_MAX * 4 + 1024;
    if (data_url != NULL) response_capacity += strlen(data_url);
    response = calloc(response_capacity, 1);
    if (response == NULL) {
        return_native_error(view, request->request_id, "INTERNAL_ERROR",
            "The selected PDF could not be prepared for rendering.");
        goto cleanup;
    }
    app_context *app = request->app;
    g_free(app->pdf_path);
    g_free(app->pdf_id);
    g_free(app->pdf_fingerprint);
    app->pdf_path = g_strdup(selected_path);
    app->pdf_id = g_strdup(fingerprint);
    app->pdf_fingerprint = g_strdup(fingerprint);
    escaped_name = g_strdup(json_escape(file_name));
    escaped_url = g_strdup(json_escape(url));
    if (escaped_name == NULL || escaped_url == NULL) {
        return_native_error(view, request->request_id, "INTERNAL_ERROR",
            "The PDF selection could not be prepared.");
        goto cleanup;
    }

    snprintf(response, response_capacity,
        "{\"name\":\"%s\",\"size\":%lld,\"url\":\"%s\",\"dataUrl\":\"%s\",\"documentId\":\"%s\"}",
        escaped_name, size, escaped_url, data_url ? data_url : "", fingerprint);
    webview_return(view, request->request_id, 0, response);

cleanup:
    free(selected_path);
    free(file_name);
    g_free(file_contents);
    g_free(data_url);
    g_free(fingerprint);
    free(escaped_name);
    free(escaped_url);
    free(url);
    free(response);
    free(request->request_id);
    free(request);
}

void on_open_pdf(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    dispatch_picker(app, id, show_pdf_picker, "PDF picker");
}

/* --- extractPdfToc binding ----------------------------------------------- */

/* Hands a finished response back to the webview thread and frees it. */
static void deliver_pdf_toc(webview_t view, void *argument) {
    pdf_toc_response *delivery = argument;
    webview_return(view, delivery->request_id, 0, delivery->response);
    g_free(delivery->request_id);
    g_free(delivery->response);
    g_free(delivery);
}

/*
 * Worker thread: cache first, then pdftotext extraction, then a queued reply.
 * Never touches the webview directly - every answer goes through
 * webview_dispatch() so it lands on the UI thread.
 */
static gpointer extract_pdf_toc_worker(gpointer argument) {
    pdf_toc_task *task = argument;
    int cached = read_cached_toc(&task->pdf, &task->toc);
    if (!cached && extract_pdf_toc(task->pdf.path, &task->toc, &task->error)) {
        write_cached_toc(&task->pdf, &task->toc);
        cached = 0;
    }

    pdf_toc_response *delivery = g_new0(pdf_toc_response, 1);
    delivery->view = task->view;
    delivery->request_id = g_strdup(task->request_id);
    if (task->error != NULL) {
        /* append_json_string keeps this off the shared json_escape buffer. */
        GString *response = g_string_new("{\"error\":{\"code\":\"TOC_EXTRACTION_FAILED\",\"message\":");
        append_json_string(response, task->error->message);
        g_string_append(response, "}}");
        delivery->response = g_string_free(response, FALSE);
    } else {
        delivery->response = build_toc_response(&task->pdf, &task->toc, cached);
    }

    if (WEBVIEW_FAILED(webview_dispatch(task->view, deliver_pdf_toc, delivery))) {
        g_free(delivery->request_id);
        g_free(delivery->response);
        g_free(delivery);
    }
    g_clear_error(&task->error);
    g_atomic_int_dec_and_test(&active_pdf_toc_jobs);
    pdf_toc_clear(&task->toc);
    g_free(task->pdf.path);
    g_free(task->pdf.fingerprint);
    g_free(task->pdf.cache_path);
    g_free(task->request_id);
    g_free(task);
    return NULL;
}

void on_extract_pdf_toc(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    if (app->pdf_path == NULL || app->pdf_id == NULL) {
        return_native_error(app->view, id, "NO_PDF_SELECTED", "Open a PDF before extracting its table of contents.");
        return;
    }

    if (g_atomic_int_get(&active_pdf_toc_jobs) > 0) {
        return_native_error(app->view, id, "TOC_BUSY", "A table of contents extraction is already running.");
        return;
    }
    if (app->pdf_toc_thread != NULL) {
        g_thread_join(app->pdf_toc_thread);
        g_thread_unref(app->pdf_toc_thread);
        app->pdf_toc_thread = NULL;
    }

    pdf_toc_task *task = g_new0(pdf_toc_task, 1);
    task->view = app->view;
    task->request_id = g_strdup(id);
    task->pdf.path = g_strdup(app->pdf_path);
    task->pdf.fingerprint = g_strdup(app->pdf_fingerprint);
    task->pdf.cache_path = toc_cache_path(app->pdf_id);
    g_atomic_int_inc(&active_pdf_toc_jobs);
    app->pdf_toc_thread = g_thread_new("pdf-toc-extraction", extract_pdf_toc_worker, task);
    if (app->pdf_toc_thread == NULL) {
        g_atomic_int_dec_and_test(&active_pdf_toc_jobs);
        g_free(task->request_id);
        g_free(task->pdf.path);
        g_free(task->pdf.fingerprint);
        g_free(task->pdf.cache_path);
        g_free(task);
        return_native_error(app->view, id, "INTERNAL_ERROR", "The table of contents worker could not start.");
    }
}
