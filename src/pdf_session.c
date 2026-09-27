/*
 * Webview-facing PDF bindings: open dialog, document identity, and the
 * background table-of-contents extraction.
 *
 * See include/pdf_session.h for the layer contract; the extraction and cache
 * logic itself lives in pdf_toc.c.
 */

#include "pdf_session.h"

#include "json_io.h"

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
 * Validates a chosen document, builds a file:// URL (or an inline data URL for
 * files up to 32 MiB), stores the document identity on app_context, and answers
 * the pending request. Shared by the chooser and the path-binding so both
 * entry points reject the same files and report the same errors.
 *
 * path is borrowed; every early return below reports the failure itself.
 */
static void answer_pdf_document(webview_t view, const char *request_id,
        app_context *app, const char *path) {
    long long size = 0;
    char *file_name = NULL;
    char *file_contents = NULL;
    gsize file_length = 0;
    char *fingerprint = NULL;
    char *data_url = NULL;
    char *url = NULL;
    GString *response = NULL;

    if (!is_valid_pdf(path, &size)) {
        return_native_error(view, request_id, "INVALID_PDF",
            "The selected file is not a readable PDF document.");
        return;
    }

    url = calloc(PATH_MAX * 3 + 8, 1);
    if (url == NULL || !build_file_url(path, url, (size_t)PATH_MAX * 3 + 8)) {
        return_native_error(view, request_id, "PDF_TOO_LARGE",
            "The selected PDF path is too long to open.");
        goto cleanup;
    }

    file_name = g_path_get_basename(path);
    fingerprint = create_pdf_fingerprint(path, size);
    if (fingerprint == NULL) {
        return_native_error(view, request_id, "INTERNAL_ERROR",
            "The selected PDF identity could not be prepared.");
        goto cleanup;
    }
    if (size <= 32LL * 1024LL * 1024LL &&
        g_file_get_contents(path, &file_contents, &file_length, NULL)) {
        char *encoded = g_base64_encode((const guchar *)file_contents, file_length);
        if (encoded != NULL) {
            data_url = g_strdup_printf("data:application/pdf;base64,%s", encoded);
            g_free(encoded);
        }
    }
    response = g_string_new(NULL);
    if (response == NULL) {
        return_native_error(view, request_id, "INTERNAL_ERROR",
            "The selected PDF could not be prepared for rendering.");
        goto cleanup;
    }
    g_free(app->pdf_path);
    g_free(app->pdf_id);
    g_free(app->pdf_fingerprint);
    app->pdf_path = g_strdup(path);
    app->pdf_id = g_strdup(fingerprint);
    app->pdf_fingerprint = g_strdup(fingerprint);
    /*
     * Built with the shared JSON writer into a growable buffer: the old
     * snprintf into a fixed buffer could deliver a truncated body with status
     * 0, and its 4 KiB escaper could silently cut a long file:// URL.
     * "path" is what the webview records in its recent-documents history, so a
     * remembered entry can be re-opened without the chooser.
     */
    g_string_append(response, "{\"name\":");
    json_append_string(response, file_name);
    g_string_append(response, ",\"path\":");
    json_append_string(response, path);
    g_string_append_printf(response, ",\"size\":%lld,\"url\":", size);
    json_append_string(response, url);
    g_string_append(response, ",\"dataUrl\":");
    json_append_string(response, data_url != NULL ? data_url : "");
    g_string_append(response, ",\"documentId\":");
    json_append_string(response, fingerprint);
    g_string_append_c(response, '}');
    webview_return(view, request_id, 0, response->str);

cleanup:
    g_free(file_name);
    g_free(file_contents);
    g_free(data_url);
    g_free(fingerprint);
    free(url);
    if (response != NULL) g_string_free(response, TRUE);
}

/*
 * Runs on the GTK main loop after dispatch_picker(): ask for a document, then
 * hand the choice to the shared answer path.
 */
static void show_pdf_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected_path = run_path_chooser(view, PICKER_OPEN_FILE, "Open PDF", &pdf_picker_filter, NULL);

    if (selected_path == NULL) {
        char canceled[] = "{\"canceled\":true}";
        webview_return(view, request->request_id, 0, canceled);
    } else {
        answer_pdf_document(view, request->request_id, request->app, selected_path);
    }
    free(selected_path);
    picker_request_release(request);
}

/*
 * Runs on the GTK main loop after dispatch_picker_with_payload(): open the
 * document the webview named, with no chooser. The path is decoded through the
 * shared JSON codec, so it is validated exactly like any other binding payload,
 * and must be absolute - a relative path would silently resolve against the
 * host's working directory.
 */
static void open_pdf_at_path(webview_t view, void *argument) {
    picker_request *request = argument;
    char *values[1] = { NULL };
    json_result decoded = request->payload == NULL
        ? JSON_ERR_NULL
        : json_read_string_array(request->payload, 1, values, NULL);

    if (decoded != JSON_OK) {
        return_native_error(view, request->request_id, "INVALID_PATH",
            "The document path could not be read.");
    } else if (!g_path_is_absolute(values[0])) {
        return_native_error(view, request->request_id, "INVALID_PATH",
            "The document path must be absolute.");
    } else {
        answer_pdf_document(view, request->request_id, request->app, values[0]);
    }
    json_free_values(values, 1);
    picker_request_release(request);
}

void on_open_pdf_at(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char *payload = NULL;

    if (request == NULL) {
        return_native_error(app->view, id, "INVALID_PATH",
            "The document path could not be read.");
        return;
    }
    payload = g_strdup(request);
    if (payload == NULL) {
        return_native_error(app->view, id, "INTERNAL_ERROR",
            "The document request could not be prepared.");
        return;
    }
    dispatch_picker_with_payload(app, id, open_pdf_at_path, "PDF request", payload);
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
        /* Same error shape as every other binding, written by the codec. */
        GString *response = g_string_new(NULL);
        json_append_error(response, "TOC_EXTRACTION_FAILED", task->error->message);
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
