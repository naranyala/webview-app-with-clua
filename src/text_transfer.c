/*
 * Text file transfers behind the openTextFile and saveTextFile bindings.
 *
 * The decode and file-name helpers are pure C so tests cover them without a
 * GUI; the two picker callbacks run on the GTK main loop through
 * dispatch_picker_with_payload(), which is how the raw argument list reaches
 * the save callback (it is validated once before the dialog opens and decoded
 * again after the path is chosen).
 */

#include "text_transfer.h"

#include "json_io.h"

#include <glib/gstdio.h>
#include <stdlib.h>
#include <string.h>

/* --- request decoding (pure) ---------------------------------------------- */

/*
 * Decodes ["name", "content"] through the shared codec, so this binding and
 * saveWorkspace validate a payload identically. The 8 MiB cap is checked on
 * the decoded length, which the codec reports exactly.
 */
text_transfer_status text_transfer_decode_save_request(const char *request, char **name, char **content) {
    json_result status;
    char *values[2] = {NULL, NULL};
    size_t lengths[2] = {0, 0};

    if (name != NULL) *name = NULL;
    if (content != NULL) *content = NULL;
    if (name == NULL || content == NULL) return TEXT_TRANSFER_ERR_NULL;
    if (request == NULL) return TEXT_TRANSFER_ERR_NULL;

    status = json_read_string_array(request, 2, values, lengths);
    if (status == JSON_ERR_MEMORY) return TEXT_TRANSFER_ERR_MEMORY;
    if (status != JSON_OK) {
        json_free_values(values, 2);
        return TEXT_TRANSFER_ERR_ARGUMENT;
    }

    if (lengths[1] > TEXT_TRANSFER_MAX_BYTES) {
        json_free_values(values, 2);
        return TEXT_TRANSFER_ERR_TOO_LARGE;
    }

    *name = values[0];
    *content = values[1];
    return TEXT_TRANSFER_OK;
}

/* --- suggested file names (pure) ------------------------------------------ */

#define TEXT_TRANSFER_NAME_CAP 60

char *text_transfer_suggest_name(const char *requested, const char *fallback) {
    const char *base = requested != NULL ? requested : "";
    const char *slash = strrchr(base, '/');
    const char *backslash = strrchr(base, '\\');
    const char *source;
    size_t length;
    char *clean;
    size_t used = 0;
    char *start;
    char *end;

    if (slash != NULL) base = slash + 1;
    if (backslash != NULL && backslash + 1 > base) base = backslash + 1;
    source = base;

    length = strlen(source);
    clean = malloc(length + 1);
    if (clean == NULL) return NULL;

    for (size_t i = 0; i < length; i++) {
        unsigned char character = (unsigned char)source[i];
        if (character < 0x20 || character == 0x7F ||
            strchr("<>:\"|?*/\\", (int)character) != NULL) {
            clean[used++] = '_';
        } else {
            clean[used++] = (char)character;
        }
    }
    clean[used] = '\0';

    /* Cap on a UTF-8 boundary so a multi-byte character is never split. */
    if (used > TEXT_TRANSFER_NAME_CAP) {
        size_t keep = TEXT_TRANSFER_NAME_CAP;
        while (keep > 0 && (((unsigned char)clean[keep] & 0xC0) == 0x80)) keep--;
        clean[keep] = '\0';
        used = keep;
    }

    start = clean;
    while (*start == ' ' || *start == '.') start++;
    end = start + strlen(start);
    while (end > start && (end[-1] == ' ' || end[-1] == '.')) end--;
    *end = '\0';
    if (start != clean) memmove(clean, start, (size_t)(end - start) + 1);

    if (clean[0] == '\0') {
        const char *safe = (fallback != NULL && fallback[0] != '\0') ? fallback : "export.txt";
        free(clean);
        clean = malloc(strlen(safe) + 1);
        if (clean != NULL) strcpy(clean, safe);
    }
    return clean;
}

const char *text_transfer_strerror(text_transfer_status status) {
    switch (status) {
        case TEXT_TRANSFER_OK:
            return "The transfer completed.";
        case TEXT_TRANSFER_ERR_NULL:
            return "The transfer request was missing.";
        case TEXT_TRANSFER_ERR_ARGUMENT:
            return "The transfer request was malformed.";
        case TEXT_TRANSFER_ERR_TOO_LARGE:
            return "That text is larger than the 8 MiB transfer limit.";
        case TEXT_TRANSFER_ERR_MEMORY:
            return "The transfer request could not be prepared.";
    }
    return "The transfer request could not be prepared.";
}

/* --- picker callbacks (GTK main loop) ------------------------------------- */

static void answer_canceled(webview_t view, picker_request *request) {
    webview_return(view, request->request_id, 0, "{\"canceled\":true}");
}

/*
 * Runs on the GTK main loop after dispatch_picker(): open the chooser, read
 * the chosen file under the size cap, and answer with its name, path, and
 * contents.
 */
static void show_text_open_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected_path = run_path_chooser(view, PICKER_OPEN_FILE, "Open Text File", NULL, NULL);
    GStatBuf info;
    GError *error = NULL;
    gchar *contents = NULL;
    gsize length = 0;

    if (selected_path == NULL) {
        answer_canceled(view, request);
        picker_request_release(request);
        return;
    }

    /*
     * The cap is checked from the file metadata first: reading a multi-gigabyte
     * file into memory only to reject it afterwards is how a "read a document"
     * action takes the process down.
     */
    if (g_stat(selected_path, &info) != 0) {
        return_native_error(view, request->request_id, "READ_FAILED",
            "The selected file could not be read.");
        free(selected_path);
        picker_request_release(request);
        return;
    }
    if ((guint64)info.st_size > (guint64)TEXT_TRANSFER_MAX_BYTES) {
        return_native_error(view, request->request_id, "FILE_TOO_LARGE",
            "That file is larger than the 8 MiB import limit.");
        free(selected_path);
        picker_request_release(request);
        return;
    }
    if (!g_file_get_contents(selected_path, &contents, &length, &error)) {
        g_clear_error(&error);
        return_native_error(view, request->request_id, "READ_FAILED",
            "The selected file could not be read.");
        free(selected_path);
        picker_request_release(request);
        return;
    }
    /* The file may have grown between the stat and the read. */
    if (length > TEXT_TRANSFER_MAX_BYTES) {
        return_native_error(view, request->request_id, "FILE_TOO_LARGE",
            "That file is larger than the 8 MiB import limit.");
        g_free(contents);
        free(selected_path);
        picker_request_release(request);
        return;
    }

    {
        gchar *file_name = g_path_get_basename(selected_path);
        GString *response = g_string_new(NULL);
        g_string_append(response, "{\"name\":");
        json_append_string(response, file_name);
        g_string_append(response, ",\"path\":");
        json_append_string(response, selected_path);
        g_string_append(response, ",\"content\":");
        json_append_string(response, contents);
        g_string_append(response, "}");
        webview_return(view, request->request_id, 0, response->str);
        g_string_free(response, TRUE);
        g_free(file_name);
    }
    g_free(contents);
    free(selected_path);
    picker_request_release(request);
}

/*
 * Runs on the GTK main loop after dispatch_picker_with_payload(): decode the
 * stashed request, open the save chooser seeded with the sanitized name, and
 * write the payload atomically (g_file_set_contents uses a temp file plus
 * rename in the destination folder).
 */
static void show_text_save_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *name = NULL;
    char *content = NULL;
    char *suggested = NULL;
    char *selected_path = NULL;
    text_transfer_status status = text_transfer_decode_save_request(request->payload, &name, &content);

    if (status != TEXT_TRANSFER_OK) {
        return_native_error(view, request->request_id, "INVALID_ARGUMENT", text_transfer_strerror(status));
        picker_request_release(request);
        return;
    }

    suggested = text_transfer_suggest_name(name, "export.txt");
    if (suggested == NULL) {
        return_native_error(view, request->request_id, "INTERNAL_ERROR",
            "The file name could not be prepared.");
        free(name);
        free(content);
        picker_request_release(request);
        return;
    }

    selected_path = run_path_chooser(view, PICKER_SAVE_FILE, "Save Text File", NULL, suggested);
    if (selected_path == NULL) {
        answer_canceled(view, request);
        free(suggested);
        free(name);
        free(content);
        picker_request_release(request);
        return;
    }

    {
        gsize length = strlen(content);
        GError *error = NULL;
        if (!g_file_set_contents(selected_path, content, (gssize)length, &error)) {
            g_clear_error(&error);
            return_native_error(view, request->request_id, "WRITE_FAILED",
                "The file could not be written.");
        } else {
            gchar *file_name = g_path_get_basename(selected_path);
            GString *response = g_string_new(NULL);
            g_string_append(response, "{\"name\":");
            json_append_string(response, file_name);
            g_string_append(response, ",\"path\":");
            json_append_string(response, selected_path);
            g_string_append_printf(response, ",\"bytes\":%llu", (unsigned long long)length);
            g_string_append(response, "}");
            webview_return(view, request->request_id, 0, response->str);
            g_string_free(response, TRUE);
            g_free(file_name);
        }
    }
    free(selected_path);
    free(suggested);
    free(name);
    free(content);
    picker_request_release(request);
}

/* --- bindings ------------------------------------------------------------- */

void on_open_text_file(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    dispatch_picker(app, id, show_text_open_picker, "text file picker");
}

void on_save_text_file(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char *name = NULL;
    char *content = NULL;
    char *payload = NULL;
    text_transfer_status status = text_transfer_decode_save_request(request, &name, &content);

    if (status != TEXT_TRANSFER_OK) {
        return_native_error(app->view, id, "INVALID_ARGUMENT", text_transfer_strerror(status));
        return;
    }
    free(name);
    free(content);

    payload = g_strdup(request);
    if (payload == NULL) {
        return_native_error(app->view, id, "INTERNAL_ERROR",
            "The transfer request could not be prepared.");
        return;
    }
    dispatch_picker_with_payload(app, id, show_text_save_picker, "text save picker", payload);
}
