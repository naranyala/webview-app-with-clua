#include "metrics.h"
#include "webview_bridge.h"
#include "workspace_store.h"

#include <webview/webview.h>
#include <gtk/gtk.h>

#include <ctype.h>
#include <glib/gstdio.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

typedef struct {
    webview_t view;
    char *pdf_path;
    char *pdf_id;
    char *pdf_fingerprint;
    GThread *pdf_toc_thread;
} app_context;

#ifndef METRICS_ENABLE_DEVTOOLS
#define METRICS_ENABLE_DEVTOOLS 1
#endif

static const char *webview_error_name(webview_error_t error) {
    switch (error) {
        case WEBVIEW_ERROR_OK:                      return "OK";
        case WEBVIEW_ERROR_UNSPECIFIED:             return "UNSPECIFIED";
        case WEBVIEW_ERROR_INVALID_ARGUMENT:        return "INVALID_ARGUMENT";
        case WEBVIEW_ERROR_INVALID_STATE:           return "INVALID_STATE";
        case WEBVIEW_ERROR_DUPLICATE:               return "DUPLICATE";
        case WEBVIEW_ERROR_NOT_FOUND:               return "NOT_FOUND";
        case WEBVIEW_ERROR_CANCELED:                return "CANCELED";
        case WEBVIEW_ERROR_MISSING_DEPENDENCY:      return "MISSING_DEPENDENCY";
        default:                                    return "UNKNOWN";
    }
}

static int check_webview_error(const char *operation, webview_error_t error) {
    if (WEBVIEW_FAILED(error)) {
        fprintf(stderr, "WebView %s failed: error=%s (%d).\n",
                operation, webview_error_name(error), (int)error);
        return 0;
    }
    return 1;
}

static int is_url_safe_path_char(unsigned char value) {
    return isalnum(value) || value == '/' || value == '-' || value == '_' || value == '.' || value == '~';
}

static int build_file_url(const char *path, char *url, size_t url_size) {
    static const char hex[] = "0123456789ABCDEF";
    size_t used = 0;
    if (path == NULL || url == NULL || url_size < 8) return 0;
    if (snprintf(url, url_size, "file://") >= (int)url_size) return 0;
    used = strlen(url);
    for (; *path != '\0'; path++) {
        unsigned char value = (unsigned char)*path;
        if (is_url_safe_path_char(value)) {
            if (used + 1 >= url_size) return 0;
            url[used++] = (char)value;
        } else {
            if (used + 3 >= url_size) return 0;
            url[used++] = '%';
            url[used++] = hex[value >> 4];
            url[used++] = hex[value & 0x0F];
        }
    }
    url[used] = '\0';
    return 1;
}

static void on_summarize(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char response[512];
    bridge_error err;

    if (request == NULL) {
        fprintf(stderr, "summarize: received null request\n");
        webview_return(app->view, id, 1, "{\"error\":{\"code\":\"NULL_REQUEST\",\"message\":\"No request data received.\"}}");
        return;
    }

    fprintf(stderr, "summarize request: %s\n", request);

    err = summarize_request(request, response, sizeof(response));

    if (err == BRIDGE_OK) {
        fprintf(stderr, "summarize response: OK\n");
    } else {
        fprintf(stderr, "summarize error: %s (code=%d)\n", bridge_strerror(err), (int)err);
    }

    if (response[0] == '\0') {
        fprintf(stderr, "summarize: response buffer empty, sending fallback error\n");
        webview_return(app->view, id, 1,
            "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Response could not be generated.\"}}");
        return;
    }

    if (WEBVIEW_FAILED(webview_return(app->view, id, err == BRIDGE_OK ? 0 : 1, response))) {
        fprintf(stderr, "summarize: webview_return failed, unable to deliver response to frontend\n");
    }
}

typedef struct {
    char *request_id;
    app_context *app;
} pdf_open_request;

static gint active_pdf_toc_jobs = 0;

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

static const char *json_escape(const char *value) {
    static char escaped[4096];
    size_t used = 0;

    for (; *value != '\0' && used + 7 < sizeof(escaped); value++) {
        unsigned char character = (unsigned char)*value;
        if (character == '"' || character == '\\') {
            escaped[used++] = '\\';
            escaped[used++] = (char)character;
        } else if (character < 0x20) {
            used += (size_t)snprintf(escaped + used, sizeof(escaped) - used, "\\u%04x", character);
        } else {
            escaped[used++] = (char)character;
        }
    }

    escaped[used] = '\0';
    return escaped;
}

typedef struct {
    int page;
    int level;
    double position;
    char *title;
} pdf_heading;

typedef struct {
    pdf_heading *items;
    size_t count;
} pdf_toc;

typedef struct {
    char *key;
    int page;
    double height;
    GString *title;
} text_line;

typedef struct {
    char *path;
    char *fingerprint;
    char *cache_path;
} pdf_toc_request;

typedef struct {
    webview_t view;
    char *request_id;
    pdf_toc_request pdf;
    pdf_toc toc;
    GError *error;
} pdf_toc_task;

typedef struct {
    webview_t view;
    char *request_id;
    char *response;
} pdf_toc_response;

static void pdf_toc_clear(pdf_toc *toc) {
    for (size_t index = 0; index < toc->count; index++) free(toc->items[index].title);
    free(toc->items);
    toc->items = NULL;
    toc->count = 0;
}

static int append_heading(pdf_toc *toc, int page, int level, double position, const char *title) {
    GString *clean_title = g_string_new(NULL);
    pdf_heading *resized;

    for (const char *character = title; *character != '\0'; character++) {
        if (*character == '\t' || *character == '\r' || *character == '\n') g_string_append_c(clean_title, ' ');
        else if (*character != ' ' || clean_title->len == 0 || clean_title->str[clean_title->len - 1] != ' ') {
            g_string_append_c(clean_title, *character);
        }
    }
    g_strstrip(clean_title->str);
    if (clean_title->len == 0 || clean_title->len > 180) {
        g_string_free(clean_title, TRUE);
        return 0;
    }
    if (toc->count > 0) {
        pdf_heading *previous = &toc->items[toc->count - 1];
        if (previous->page == page && g_strcmp0(previous->title, clean_title->str) == 0) {
            g_string_free(clean_title, TRUE);
            return 0;
        }
    }
    resized = realloc(toc->items, (toc->count + 1) * sizeof(*toc->items));
    if (resized == NULL) {
        g_string_free(clean_title, TRUE);
        return 0;
    }
    toc->items = resized;
    toc->items[toc->count++] = (pdf_heading){
        .page = page,
        .level = level,
        .position = position,
        .title = g_string_free(clean_title, FALSE),
    };
    return 1;
}

static int is_numbered_heading(const char *title) {
    while (*title == ' ') title++;
    if (g_ascii_isdigit(*title)) return 1;
    const char *prefixes[] = { "chapter ", "section ", "appendix " };
    for (size_t index = 0; index < G_N_ELEMENTS(prefixes); index++) {
        size_t length = strlen(prefixes[index]);
        if (g_ascii_strncasecmp(title, prefixes[index], length) != 0) continue;
        const char *number = title + length;
        while (*number == ' ') number++;
        return g_ascii_isdigit(*number);
    }
    return 0;
}

static int is_title_like(const char *title) {
    int alpha_count = 0;
    int uppercase_count = 0;
    int word_start = 1;
    int lowercase_word_start = 0;

    for (const unsigned char *character = (const unsigned char *)title; *character != '\0'; character++) {
        if (g_ascii_isalpha(*character)) {
            alpha_count++;
            if (g_ascii_isupper(*character)) uppercase_count++;
            if (word_start) {
                if (g_ascii_islower(*character)) lowercase_word_start = 1;
                word_start = 0;
            }
        } else if (g_ascii_isspace(*character)) {
            word_start = 1;
        }
    }
    return alpha_count >= 2 && (uppercase_count == alpha_count || !lowercase_word_start);
}

static int is_text_heading(const char *title, double size_ratio) {
    int alpha_count = 0;
    int word_count = 1;
    size_t length = g_utf8_strlen(title, -1);
    const char *last = title + strlen(title) - 1;

    if (length < 2 || length > 100 || (last[0] == '.' || last[0] == ',' || last[0] == ';' || last[0] == ':')) return 0;
    for (const unsigned char *character = (const unsigned char *)title; *character != '\0'; character++) {
        if (g_ascii_isalpha(*character)) alpha_count++;
        if (*character == ' ') word_count++;
    }
    if (alpha_count < 2 || word_count > 12) return 0;
    if (is_numbered_heading(title)) return 1;
    if (size_ratio >= 1.55) return is_title_like(title);
    return size_ratio >= 1.25 && is_title_like(title);
}

static int compare_double(const void *left, const void *right) {
    double difference = *(const double *)left - *(const double *)right;
    return (difference > 0) - (difference < 0);
}

static int run_pdftotext(const char *path, const char *option, char **output, GError **error) {
    char *arguments[] = {
        (char *)PDFTOTEXT_EXECUTABLE, (char *)"-q", (char *)"-enc", (char *)"UTF-8",
        (char *)option, (char *)path, (char *)"-", NULL,
    };
    int wait_status = 0;
    g_spawn_sync(NULL, arguments, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL,
        output, NULL, &wait_status, error);
    return error == NULL || *error == NULL;
}

static int extract_tsv_headings(const char *text, pdf_toc *toc) {
    char **rows = g_strsplit(text, "\n", -1);
    text_line *lines = NULL;
    size_t line_count = 0;
    double *heights = NULL;

    for (char **row = rows; *row != NULL; row++) {
        if (g_ascii_strncasecmp(*row, "level\t", 6) == 0 || strchr(*row, '\t') == NULL) continue;
        char **fields = g_strsplit(*row, "\t", -1);
        int field_count = g_strv_length(fields);
        if (field_count < 12 || strcmp(fields[0], "5") != 0) {
            g_strfreev(fields);
            continue;
        }
        char *key = g_strdup_printf("%s:%s:%s:%s", fields[1], fields[2], fields[3], fields[4]);
        if (line_count == 0 || g_strcmp0(lines[line_count - 1].key, key) != 0) {
            text_line *resized = realloc(lines, (line_count + 1) * sizeof(*lines));
            if (resized == NULL) {
                g_free(key);
                g_strfreev(fields);
                g_strfreev(rows);
                return 0;
            }
            lines = resized;
            lines[line_count++] = (text_line){
                .key = key,
                .page = atoi(fields[1]),
                .height = g_ascii_strtod(fields[9], NULL),
                .title = g_string_new(NULL),
            };
        } else {
            g_free(key);
        }
        if (lines[line_count - 1].title->len > 0) g_string_append_c(lines[line_count - 1].title, ' ');
        g_string_append(lines[line_count - 1].title, fields[11]);
        g_strfreev(fields);
    }
    g_strfreev(rows);

    if (line_count == 0) {
        free(lines);
        return 0;
    }
    heights = g_new(double, line_count);
    for (size_t index = 0; index < line_count; index++) heights[index] = lines[index].height;
    qsort(heights, line_count, sizeof(double), compare_double);
    double body_height = line_count % 2 == 0
        ? heights[line_count / 2 - 1]
        : heights[line_count / 2];
    if (body_height <= 0) body_height = 1;

    for (size_t index = 0; index < line_count; index++) {
        double ratio = lines[index].height / body_height;
        if (is_text_heading(lines[index].title->str, ratio)) {
            int level = is_numbered_heading(lines[index].title->str) || ratio >= 1.5 ? 1 : ratio >= 1.25 ? 2 : 3;
            append_heading(toc, lines[index].page, level, lines[index].height, lines[index].title->str);
        }
        g_string_free(lines[index].title, TRUE);
        g_free(lines[index].key);
    }
    g_free(heights);
    free(lines);
    return 1;
}

static int extract_text_headings(const char *text, pdf_toc *toc) {
    int page = 1;
    for (const char *cursor = text; *cursor != '\0';) {
        const char *end = strchr(cursor, '\n');
        if (end == NULL) end = cursor + strlen(cursor);
        char *line = g_strndup(cursor, end - cursor);
        g_strstrip(line);
        if (is_text_heading(line, 1)) append_heading(toc, page, is_numbered_heading(line) ? 1 : 2, 0, line);
        if (*end == '\f') page++;
        g_free(line);
        cursor = *end == '\0' ? end : end + 1;
    }
    return toc->count > 0;
}

static int extract_pdf_toc(const char *path, pdf_toc *toc, GError **error) {
    char *output = NULL;
    if (!run_pdftotext(path, "-tsv", &output, error)) {
        g_free(output);
        return 0;
    }
    extract_tsv_headings(output, toc);
    g_free(output);
    output = NULL;
    if (toc->count == 0 && !run_pdftotext(path, "-layout", &output, error)) {
        g_free(output);
        g_clear_error(error);
        g_set_error(error, G_FILE_ERROR, G_FILE_ERROR_FAILED, "Could not read text from the selected PDF.");
        return 0;
    }
    if (toc->count == 0) extract_text_headings(output, toc);
    g_free(output);
    if (toc->count == 0) {
        g_set_error(error, G_FILE_ERROR, G_FILE_ERROR_FAILED, "No headings could be extracted from this PDF.");
        return 0;
    }
    return 1;
}

static char *toc_cache_path(const char *document_id) {
    char *directory = g_build_filename(g_get_user_data_dir(), "native-workspace", "pdf-toc", NULL);
    g_mkdir_with_parents(directory, 0700);
    char *path = g_build_filename(directory, document_id, NULL);
    g_free(directory);
    return path;
}

static int read_cached_toc(const pdf_toc_request *request, pdf_toc *toc) {
    char *contents = NULL;
    if (!g_file_get_contents(request->cache_path, &contents, NULL, NULL)) return 0;
    char **rows = g_strsplit(contents, "\n", -1);
    int valid = g_strv_length(rows) >= 2 && g_strcmp0(rows[0], "native-workspace-pdf-toc-v1") == 0 &&
                g_strcmp0(rows[1], request->fingerprint) == 0;
    if (valid) {
        for (size_t index = 2; index < g_strv_length(rows) && rows[index][0] != '\0'; index++) {
            char **fields = g_strsplit(rows[index], "\t", -1);
            if (g_strv_length(fields) == 5) {
                gsize title_length = 0;
                char *title = (char *)g_base64_decode(fields[4], &title_length);
                if (title != NULL && append_heading(toc, atoi(fields[1]), atoi(fields[3]), g_ascii_strtod(fields[2], NULL), title)) {
                    free(toc->items[toc->count - 1].title);
                    toc->items[toc->count - 1].title = title;
                } else {
                    g_free(title);
                }
            }
            g_strfreev(fields);
        }
    }
    g_strfreev(rows);
    g_free(contents);
    return valid && toc->count > 0;
}

static void write_cached_toc(const pdf_toc_request *request, const pdf_toc *toc) {
    GString *contents = g_string_new("native-workspace-pdf-toc-v1\n");
    g_string_append_printf(contents, "%s\n", request->fingerprint);
    for (size_t index = 0; index < toc->count; index++) {
        char *encoded = g_base64_encode((const guchar *)toc->items[index].title, strlen(toc->items[index].title));
        g_string_append_printf(contents, "H\t%d\t%.2f\t%d\t%s\n", toc->items[index].page,
            toc->items[index].position, toc->items[index].level, encoded);
        g_free(encoded);
    }
    g_file_set_contents(request->cache_path, contents->str, contents->len, NULL);
    g_string_free(contents, TRUE);
}

static char *build_toc_response(const pdf_toc_request *request, const pdf_toc *toc, int cached) {
    GString *response = g_string_new("{\"documentId\":");
    g_string_append_printf(response, "\"%s\",\"cached\":%s,\"headings\":[", request->fingerprint, cached ? "true" : "false");
    for (size_t index = 0; index < toc->count; index++) {
        if (index > 0) g_string_append_c(response, ',');
        g_string_append_printf(response, "{\"page\":%d,\"level\":%d,\"position\":%.2f,\"title\":\"%s\"}",
            toc->items[index].page, toc->items[index].level, toc->items[index].position, json_escape(toc->items[index].title));
    }
    g_string_append(response, "]}");
    return g_string_free(response, FALSE);
}

static void return_pdf_error(webview_t view, const char *request_id, const char *code, const char *message) {
    char response[1024];
    snprintf(response, sizeof(response),
        "{\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}",
        code, json_escape(message));
    webview_return(view, request_id, 1, response);
}

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

static void show_pdf_picker(webview_t view, void *argument) {
    pdf_open_request *request = argument;
    GtkWindow *parent = webview_get_native_handle(view, WEBVIEW_NATIVE_HANDLE_KIND_UI_WINDOW);
    GtkWidget *dialog = gtk_file_chooser_dialog_new(
        "Open PDF",
        parent,
        GTK_FILE_CHOOSER_ACTION_OPEN,
        "_Cancel",
        GTK_RESPONSE_CANCEL,
        "_Open",
        GTK_RESPONSE_ACCEPT,
        NULL);
    GtkFileChooser *chooser = GTK_FILE_CHOOSER(dialog);
    GtkFileFilter *filter = gtk_file_filter_new();
    char *selected_path = NULL;
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

    gtk_window_set_modal(GTK_WINDOW(dialog), TRUE);
    gtk_window_set_title(GTK_WINDOW(dialog), "Open PDF");
    gtk_file_filter_set_name(filter, "PDF documents (*.pdf)");
    gtk_file_filter_add_pattern(filter, "*.pdf");
    gtk_file_filter_add_mime_type(filter, "application/pdf");
    gtk_file_chooser_add_filter(chooser, filter);
    gtk_file_chooser_set_current_folder(chooser, g_get_home_dir());

    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
        selected_path = gtk_file_chooser_get_filename(chooser);
    }
    gtk_widget_destroy(dialog);

    if (selected_path == NULL) {
        char canceled[] = "{\"canceled\":true}";
        webview_return(view, request->request_id, 0, canceled);
        goto cleanup;
    }

    if (!is_valid_pdf(selected_path, &size)) {
        return_pdf_error(view, request->request_id, "INVALID_PDF",
            "The selected file is not a readable PDF document.");
        goto cleanup;
    }

    url = calloc(PATH_MAX * 3 + 8, 1);
    if (url == NULL || !build_file_url(selected_path, url, (size_t)PATH_MAX * 3 + 8)) {
        return_pdf_error(view, request->request_id, "PDF_TOO_LARGE",
            "The selected PDF path is too long to open.");
        goto cleanup;
    }

    file_name = g_path_get_basename(selected_path);
    fingerprint = create_pdf_fingerprint(selected_path, size);
    if (fingerprint == NULL) {
        return_pdf_error(view, request->request_id, "INTERNAL_ERROR",
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
        return_pdf_error(view, request->request_id, "INTERNAL_ERROR",
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
        return_pdf_error(view, request->request_id, "INTERNAL_ERROR",
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

static void on_open_pdf(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    pdf_open_request *pending = calloc(1, sizeof(*pending));
    webview_error_t error;

    if (pending == NULL) {
        webview_return(app->view, id, 1,
            "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Could not start the PDF picker.\"}}");
        return;
    }

    pending->request_id = g_strdup(id);
    pending->app = app;
    if (pending->request_id == NULL) {
        free(pending);
        webview_return(app->view, id, 1,
            "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Could not start the PDF picker.\"}}");
        return;
    }

    error = webview_dispatch(app->view, show_pdf_picker, pending);
    if (WEBVIEW_FAILED(error)) {
        free(pending->request_id);
        free(pending);
        webview_return(app->view, id, 1,
            "{\"error\":{\"code\":\"DISPATCH_ERROR\",\"message\":\"The PDF picker could not be opened.\"}}");
    }
}

static void deliver_pdf_toc(webview_t view, void *argument) {
    pdf_toc_response *delivery = argument;
    webview_return(view, delivery->request_id, 0, delivery->response);
    g_free(delivery->request_id);
    g_free(delivery->response);
    g_free(delivery);
}

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
    delivery->response = task->error != NULL
        ? g_strdup_printf("{\"error\":{\"code\":\"TOC_EXTRACTION_FAILED\",\"message\":\"%s\"}}",
            json_escape(task->error->message))
        : build_toc_response(&task->pdf, &task->toc, cached);

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

static void on_extract_pdf_toc(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    if (app->pdf_path == NULL || app->pdf_id == NULL) {
        return_pdf_error(app->view, id, "NO_PDF_SELECTED", "Open a PDF before extracting its table of contents.");
        return;
    }

    if (g_atomic_int_get(&active_pdf_toc_jobs) > 0) {
        return_pdf_error(app->view, id, "TOC_BUSY", "A table of contents extraction is already running.");
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
        return_pdf_error(app->view, id, "INTERNAL_ERROR", "The table of contents worker could not start.");
    }
}

#define IMAGE_SCAN_MAX_DEPTH 8
#define IMAGE_SCAN_MAX_FILES 500
#define IMAGE_SCAN_MAX_FILE_SIZE (16LL * 1024LL * 1024LL)
#define IMAGE_SCAN_MAX_TOTAL_SIZE (96LL * 1024LL * 1024LL)

typedef struct {
    char *request_id;
} image_directory_request;

typedef struct {
    GString *json;
    size_t count;
    long long total_size;
    int limited;
} image_scan_result;

static const char *image_mime_type(const char *name) {
    static const struct { const char *extension; const char *mime; } types[] = {
        { ".avif", "image/avif" }, { ".bmp", "image/bmp" }, { ".gif", "image/gif" },
        { ".heic", "image/heic" }, { ".heif", "image/heif" }, { ".ico", "image/x-icon" },
        { ".jpeg", "image/jpeg" }, { ".jpg", "image/jpeg" }, { ".png", "image/png" },
        { ".svg", "image/svg+xml" }, { ".tif", "image/tiff" }, { ".tiff", "image/tiff" },
        { ".webp", "image/webp" },
    };
    char *lowercase_name = g_ascii_strdown(name, -1);
    const char *mime = NULL;
    for (size_t index = 0; index < G_N_ELEMENTS(types); index++) {
        if (g_str_has_suffix(lowercase_name, types[index].extension)) {
            mime = types[index].mime;
            break;
        }
    }
    g_free(lowercase_name);
    if (mime != NULL) return mime;
    return NULL;
}

static void append_json_string(GString *output, const char *value) {
    g_string_append_c(output, '"');
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
        switch (*cursor) {
            case '"': g_string_append(output, "\\\""); break;
            case '\\': g_string_append(output, "\\\\"); break;
            case '\b': g_string_append(output, "\\b"); break;
            case '\f': g_string_append(output, "\\f"); break;
            case '\n': g_string_append(output, "\\n"); break;
            case '\r': g_string_append(output, "\\r"); break;
            case '\t': g_string_append(output, "\\t"); break;
            default:
                if (*cursor < 0x20) g_string_append_printf(output, "\\u%04x", *cursor);
                else g_string_append_c(output, (char)*cursor);
        }
    }
    g_string_append_c(output, '"');
}

static void scan_image_directory(const char *directory, const char *relative, int depth, image_scan_result *result) {
    GDir *dir = g_dir_open(directory, 0, NULL);
    if (dir == NULL) return;
    const char *entry;
    while ((entry = g_dir_read_name(dir)) != NULL) {
        char *path = g_build_filename(directory, entry, NULL);
        char *relative_path = relative[0] == '\0' ? g_strdup(entry) : g_strdup_printf("%s/%s", relative, entry);
        GFile *file = g_file_new_for_path(path);
        GFileInfo *info = g_file_query_info(file, G_FILE_ATTRIBUTE_STANDARD_TYPE "," G_FILE_ATTRIBUTE_STANDARD_SIZE,
            G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS, NULL, NULL);
        GFileType type = info == NULL ? G_FILE_TYPE_UNKNOWN : g_file_info_get_file_type(info);
        if (type == G_FILE_TYPE_DIRECTORY) {
            if (depth < IMAGE_SCAN_MAX_DEPTH) scan_image_directory(path, relative_path, depth + 1, result);
        } else if (type == G_FILE_TYPE_REGULAR) {
            const char *mime = image_mime_type(entry);
            long long size = g_file_info_get_size(info);
            if (mime == NULL || size <= 0 || size > IMAGE_SCAN_MAX_FILE_SIZE) {
                g_free(relative_path);
                g_free(path);
                g_clear_object(&info);
                g_object_unref(file);
                continue;
            }
            if (result->count >= IMAGE_SCAN_MAX_FILES || result->total_size + size > IMAGE_SCAN_MAX_TOTAL_SIZE) {
                result->limited = 1;
                g_free(relative_path);
                g_free(path);
                g_clear_object(&info);
                g_object_unref(file);
                continue;
            }
            char *contents = NULL;
            gsize length = 0;
            if (g_file_get_contents(path, &contents, &length, NULL) && length == (gsize)size) {
                char *encoded = g_base64_encode((const guchar *)contents, length);
                if (encoded != NULL) {
                    if (result->count > 0) g_string_append_c(result->json, ',');
                    g_string_append(result->json, "{\"name\":");
                    append_json_string(result->json, entry);
                    g_string_append(result->json, ",\"relativePath\":");
                    append_json_string(result->json, relative_path);
                    g_string_append_printf(result->json, ",\"size\":%lld,\"dataUrl\":\"data:%s;base64,%s\"}", size, mime, encoded);
                    result->count++;
                    result->total_size += size;
                }
                g_free(encoded);
            }
            g_free(contents);
        }
        g_clear_object(&info);
        g_object_unref(file);
        g_free(relative_path);
        g_free(path);
        if (result->count >= IMAGE_SCAN_MAX_FILES || result->total_size >= IMAGE_SCAN_MAX_TOTAL_SIZE) {
            result->limited = 1;
            break;
        }
    }
    g_dir_close(dir);
}

static void return_image_error(webview_t view, const char *request_id, const char *code, const char *message) {
    GString *response = g_string_new("{\"error\":{\"code\":");
    append_json_string(response, code);
    g_string_append(response, ",\"message\":");
    append_json_string(response, message);
    g_string_append(response, "}}");
    webview_return(view, request_id, 1, response->str);
    g_string_free(response, TRUE);
}

static void show_image_directory_picker(webview_t view, void *argument) {
    image_directory_request *request = argument;
    GtkWindow *parent = webview_get_native_handle(view, WEBVIEW_NATIVE_HANDLE_KIND_UI_WINDOW);
    GtkWidget *dialog = gtk_file_chooser_dialog_new("Choose Image Directory", parent,
        GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER, "_Cancel", GTK_RESPONSE_CANCEL,
        "_Select", GTK_RESPONSE_ACCEPT, NULL);
    char *selected_path = NULL;
    gtk_window_set_modal(GTK_WINDOW(dialog), TRUE);
    gtk_file_chooser_set_current_folder(GTK_FILE_CHOOSER(dialog), g_get_home_dir());
    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
        selected_path = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
    }
    gtk_widget_destroy(dialog);
    if (selected_path == NULL) {
        webview_return(view, request->request_id, 0, "{\"canceled\":true}");
        goto cleanup;
    }

    image_scan_result scan = { .json = g_string_new("{\"images\":[") };
    scan_image_directory(selected_path, "", 0, &scan);
    char *directory_name = g_path_get_basename(selected_path);
    g_string_append_c(scan.json, ']');
    g_string_append(scan.json, ",\"name\":");
    append_json_string(scan.json, directory_name);
    g_string_append_printf(scan.json, ",\"limited\":%s}", scan.limited ? "true" : "false");
    if (scan.count == 0) {
        return_image_error(view, request->request_id, "NO_IMAGES", "No supported images were found within the directory limits.");
    } else {
        webview_return(view, request->request_id, 0, scan.json->str);
    }
    g_free(directory_name);
    g_string_free(scan.json, TRUE);

cleanup:
    g_free(selected_path);
    g_free(request->request_id);
    g_free(request);
}

static void on_open_image_directory(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    image_directory_request *pending = calloc(1, sizeof(*pending));
    if (pending == NULL) {
        webview_return(app->view, id, 1, "{\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Could not start the image directory picker.\"}}");
        return;
    }
    pending->request_id = g_strdup(id);
    if (pending->request_id == NULL || WEBVIEW_FAILED(webview_dispatch(app->view, show_image_directory_picker, pending))) {
        g_free(pending->request_id);
        g_free(pending);
        webview_return(app->view, id, 1, "{\"error\":{\"code\":\"DISPATCH_ERROR\",\"message\":\"The image directory picker could not be opened.\"}}");
    }
}

static char *workspace_file_path(void) {
    return g_build_filename(g_get_user_data_dir(), "native-workspace", "workspace.json", NULL);
}

static int ensure_workspace_directory(void) {
    char *directory = g_build_filename(g_get_user_data_dir(), "native-workspace", NULL);
    int created = g_mkdir_with_parents(directory, 0700) == 0;
    g_free(directory);
    return created;
}

static void return_workspace_error(webview_t view, const char *id, const char *code, const char *message) {
    GString *response = g_string_new("{\"error\":{\"code\":\"");
    g_string_append(response, code);
    g_string_append(response, "\",\"message\":\"");
    g_string_append(response, message);
    g_string_append(response, "\"}}");
    webview_return(view, id, 1, response->str);
    g_string_free(response, TRUE);
}

static void on_load_workspace(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    workspace_store_result store_result = WORKSPACE_STORE_OK;
    size_t length = 0;
    char *path;
    char *data;
    GString *response;

    (void)request;

    path = workspace_file_path();
    if (path == NULL) {
        return_workspace_error(app->view, id, "INTERNAL_ERROR", "The workspace location could not be determined.");
        return;
    }
    data = workspace_store_load(path, &length, &store_result);
    g_free(path);
    if (data == NULL) {
        return_workspace_error(app->view, id, "READ_FAILED", workspace_store_strerror(store_result));
        return;
    }

    fprintf(stderr, "loadWorkspace: %zu bytes from disk\n", length);

    response = g_string_new("{\"ok\":true,\"workspace\":");
    if (length > 0 && workspace_store_is_object(data, length)) {
        g_string_append_len(response, data, (gssize)length);
    } else {
        g_string_append(response, "null");
    }
    g_string_append_c(response, '}');
    webview_return(app->view, id, 0, response->str);
    g_string_free(response, TRUE);
    free(data);
}

static void on_save_workspace(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    workspace_store_result store_result = WORKSPACE_STORE_OK;
    char *payload;
    char *path;
    size_t length;

    payload = workspace_store_decode_argument(request, &store_result);
    if (payload == NULL) {
        return_workspace_error(app->view, id, "INVALID_ARGUMENT", workspace_store_strerror(store_result));
        return;
    }

    length = strlen(payload);
    if (!workspace_store_is_object(payload, length)) {
        free(payload);
        return_workspace_error(app->view, id, "INVALID_PAYLOAD", "The workspace payload must be a JSON object.");
        return;
    }
    if (!ensure_workspace_directory()) {
        free(payload);
        return_workspace_error(app->view, id, "WRITE_FAILED", workspace_store_strerror(WORKSPACE_STORE_ERR_WRITE));
        return;
    }

    path = workspace_file_path();
    if (path == NULL) {
        free(payload);
        return_workspace_error(app->view, id, "INTERNAL_ERROR", "The workspace location could not be determined.");
        return;
    }
    store_result = workspace_store_save(path, payload, length);
    g_free(path);
    if (store_result != WORKSPACE_STORE_OK) {
        free(payload);
        return_workspace_error(app->view, id,
                               store_result == WORKSPACE_STORE_ERR_TOO_LARGE ? "PAYLOAD_TOO_LARGE" : "WRITE_FAILED",
                               workspace_store_strerror(store_result));
        return;
    }

    fprintf(stderr, "saveWorkspace: %zu bytes written to disk\n", length);
    webview_return(app->view, id, 0, "{\"ok\":true}");
    free(payload);
}

static const char *frontend_diagnostics_js =
    "(function(){"
    "if(!Object.hasOwn){Object.hasOwn=function(object,property){return Object.prototype.hasOwnProperty.call(object,property);};}"
    "function report(message){"
    "  console.error(message);"
    "  function paint(){"
    "    if(!document.body)return;"
    "    var box=document.createElement('pre');"
    "    box.textContent=message;"
    "    box.style='margin:24px;padding:20px;border:2px solid #fda29b;border-radius:10px;background:#3b1620;color:#ffd6d2;font:14px monospace;white-space:pre-wrap';"
    "    document.body.appendChild(box);"
    "  }"
    "  if(document.body)paint();else document.addEventListener('DOMContentLoaded',paint);"
    "}"
    "window.addEventListener('error',function(event){report('Frontend JavaScript error: '+event.message+' at '+event.filename+':'+event.lineno+':'+event.colno);});"
    "window.addEventListener('unhandledrejection',function(event){report('Frontend promise rejection: '+String(event.reason));});"
    "}());";

static char *load_html(const char *path) {
    FILE *file;
    char *html;
    long length;

    if (path == NULL) {
        fprintf(stderr, "load_html: path is NULL\n");
        return NULL;
    }

    file = fopen(path, "rb");
    if (file == NULL) {
        fprintf(stderr, "load_html: cannot open '%s'\n", path);
        return NULL;
    }

    if (fseek(file, 0, SEEK_END) != 0) {
        fprintf(stderr, "load_html: seek failed for '%s'\n", path);
        fclose(file);
        return NULL;
    }

    length = ftell(file);
    if (length < 0) {
        fprintf(stderr, "load_html: ftell failed for '%s'\n", path);
        fclose(file);
        return NULL;
    }

    if (fseek(file, 0, SEEK_SET) != 0) {
        fprintf(stderr, "load_html: rewind failed for '%s'\n", path);
        fclose(file);
        return NULL;
    }

    html = malloc((size_t)length + 1);
    if (html == NULL) {
        fprintf(stderr, "load_html: out of memory allocating %ld bytes for '%s'\n", length, path);
        fclose(file);
        return NULL;
    }

    if (fread(html, 1, (size_t)length, file) != (size_t)length) {
        fprintf(stderr, "load_html: read failed for '%s'\n", path);
        free(html);
        fclose(file);
        return NULL;
    }

    html[length] = '\0';
    fclose(file);
    return html;
}

int main(void) {
    app_context app = {0};
    char *html = NULL;
    char file_url[8192];
    const char *render_mode = getenv("METRICS_RENDER_MODE");
    const char *frontend_url = getenv("METRICS_FRONTEND_URL");
    int use_inline_html = render_mode != NULL && strcmp(render_mode, "inline") == 0;
    int exit_code = 1;

    fprintf(stderr, "Starting metrics desktop application...\n");

    app.view = webview_create(METRICS_ENABLE_DEVTOOLS, NULL);
    if (app.view == NULL) {
        fprintf(stderr, "Fatal: Could not create WebView.\n");
        fprintf(stderr, "  Check that a graphical session is available.\n");
        fprintf(stderr, "  DISPLAY=%s\n",
                getenv("DISPLAY") != NULL ? getenv("DISPLAY") : "(unset)");
        fprintf(stderr, "  WAYLAND_DISPLAY=%s\n",
                getenv("WAYLAND_DISPLAY") != NULL ? getenv("WAYLAND_DISPLAY") : "(unset)");
        fprintf(stderr, "  Ensure GTK/WebKit runtime dependencies are installed.\n");
        goto fail;
    }

    if (!check_webview_error("set_title", webview_set_title(app.view, "C-powered Lua metrics")))
        goto fail;

    if (!check_webview_error("init frontend diagnostics", webview_init(app.view, frontend_diagnostics_js)))
        goto fail;

    {
        webview_error_t size_error = webview_set_size(app.view, 760, 540, WEBVIEW_HINT_NONE);
        if (WEBVIEW_FAILED(size_error)) {
            fprintf(stderr, "Warning: webview_set_size failed (error=%s/%d); window may use default size.\n",
                    webview_error_name(size_error), (int)size_error);
        }
    }

    if (!check_webview_error("bind summarize", webview_bind(app.view, "summarize", on_summarize, &app)))
        goto fail;

    if (!check_webview_error("bind openPdf", webview_bind(app.view, "openPdf", on_open_pdf, &app)))
        goto fail;

    if (!check_webview_error("bind openImageDirectory", webview_bind(app.view, "openImageDirectory", on_open_image_directory, &app)))
        goto fail;

    if (!check_webview_error("bind extractPdfToc", webview_bind(app.view, "extractPdfToc", on_extract_pdf_toc, &app)))
        goto fail;

    if (!check_webview_error("bind loadWorkspace", webview_bind(app.view, "loadWorkspace", on_load_workspace, &app)))
        goto fail;

    if (!check_webview_error("bind saveWorkspace", webview_bind(app.view, "saveWorkspace", on_save_workspace, &app)))
        goto fail;

    /* Try to load the frontend */
    if (!use_inline_html && frontend_url != NULL && *frontend_url != '\0') {
        fprintf(stderr, "Navigating to frontend URL: %s\n", frontend_url);
        if (!check_webview_error("navigate frontend URL", webview_navigate(app.view, frontend_url))) {
            fprintf(stderr, "Warning: Frontend URL navigation failed, falling back to inline HTML.\n");
            use_inline_html = 1;
        }
    } else if (!use_inline_html && build_file_url(APP_HTML_PATH, file_url, sizeof(file_url))) {
        fprintf(stderr, "Navigating to frontend file: %s\n", file_url);
        if (!check_webview_error("navigate frontend file", webview_navigate(app.view, file_url))) {
            fprintf(stderr, "Warning: Frontend file navigation failed, falling back to inline HTML.\n");
            use_inline_html = 1;
        }
    } else {
        if (frontend_url == NULL || *frontend_url == '\0') {
            fprintf(stderr, "No frontend URL configured, using inline HTML.\n");
        }
        use_inline_html = 1;
    }

    if (use_inline_html) {
        fprintf(stderr, "Loading inline HTML from: %s\n", APP_HTML_PATH);
        html = load_html(APP_HTML_PATH);
        if (html == NULL) {
            fprintf(stderr, "Fatal: Could not load frontend HTML from '%s'.\n", APP_HTML_PATH);
            goto fail;
        }
        if (!check_webview_error("set_html", webview_set_html(app.view, html)))
            goto fail;
    }

    fprintf(stderr, "WebView ready, entering event loop.\n");
    if (!check_webview_error("run", webview_run(app.view)))
        goto fail;

    fprintf(stderr, "WebView closed gracefully.\n");
    exit_code = 0;

fail:
    if (app.pdf_toc_thread != NULL) {
        g_thread_join(app.pdf_toc_thread);
        g_thread_unref(app.pdf_toc_thread);
    }
    webview_destroy(app.view);
    g_free(app.pdf_path);
    g_free(app.pdf_id);
    g_free(app.pdf_fingerprint);
    free(html);
    fprintf(stderr, "Exiting with code %d.\n", exit_code);
    return exit_code;
}
