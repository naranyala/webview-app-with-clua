/*
 * Shared plumbing for the desktop host: JSON escaping, error replies, file
 * URLs, and the GTK path chooser used by every picker-backed binding.
 *
 * See include/app_support.h for the layer contract and ownership rules.
 */

#include "app_support.h"

#include <ctype.h>
#include <gtk/gtk.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- file URLs ----------------------------------------------------------- */

/* Path characters that may stay literal inside a file:// URL. */
static int is_url_safe_path_char(unsigned char value) {
    return isalnum(value) || value == '/' || value == '-' || value == '_' || value == '.' || value == '~';
}

/*
 * Percent-encodes path into url (a file:// URL). Returns 1 on success and 0
 * when the buffer is too small, so callers can answer with a clear error
 * instead of a truncated path.
 */
int build_file_url(const char *path, char *url, size_t url_size) {
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

/* --- JSON helpers -------------------------------------------------------- */

/*
 * Escapes a string for embedding in a JSON document. The result lives in a
 * shared static buffer: duplicate it (g_strdup) before the next call, and do
 * not call from two threads at once.
 */
const char *json_escape(const char *value) {
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

/* Appends value wrapped in double quotes with full JSON escaping. */
void append_json_string(GString *output, const char *value) {
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

/*
 * Rejects a request with the shared error shape used by every binding. The
 * frontend unwraps {error:{code,message}} into its workspace report, so codes
 * and messages must stay user-readable.
 */
void return_native_error(webview_t view, const char *request_id, const char *code, const char *message) {
    GString *response = g_string_new("{\"error\":{\"code\":");
    append_json_string(response, code);
    g_string_append(response, ",\"message\":");
    append_json_string(response, message);
    g_string_append(response, "}}");
    webview_return(view, request_id, 1, response->str);
    g_string_free(response, TRUE);
}

/* --- GTK path chooser ---------------------------------------------------- */

/*
 * Modal GTK chooser shared by the PDF and image pickers. Returns the selected
 * path (caller frees) or NULL when the user cancelled.
 */
char *run_path_chooser(webview_t view, picker_kind kind, const char *title,
    const picker_filter *filter) {
    GtkWindow *parent = webview_get_native_handle(view, WEBVIEW_NATIVE_HANDLE_KIND_UI_WINDOW);
    GtkWidget *dialog = gtk_file_chooser_dialog_new(
        title,
        parent,
        kind == PICKER_SELECT_FOLDER ? GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER : GTK_FILE_CHOOSER_ACTION_OPEN,
        "_Cancel",
        GTK_RESPONSE_CANCEL,
        kind == PICKER_SELECT_FOLDER ? "_Select" : "_Open",
        GTK_RESPONSE_ACCEPT,
        NULL);
    GtkFileChooser *chooser = GTK_FILE_CHOOSER(dialog);
    char *selected_path = NULL;

    gtk_window_set_modal(GTK_WINDOW(dialog), TRUE);
    if (filter != NULL) {
        GtkFileFilter *file_filter = gtk_file_filter_new();
        gtk_file_filter_set_name(file_filter, filter->filter_name);
        gtk_file_filter_add_pattern(file_filter, filter->filter_pattern);
        if (filter->filter_mime != NULL) {
            gtk_file_filter_add_mime_type(file_filter, filter->filter_mime);
        }
        gtk_file_chooser_add_filter(chooser, file_filter);
    }
    gtk_file_chooser_set_current_folder(chooser, g_get_home_dir());

    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
        selected_path = gtk_file_chooser_get_filename(chooser);
    }
    gtk_widget_destroy(dialog);
    return selected_path;
}

/*
 * Runs a picker on the GTK main loop. GTK dialogs are blocking, so the work
 * must leave the binding callback; on any failure this routine rejects the
 * request itself and returns 0, which keeps reporting in one place.
 */
int dispatch_picker(app_context *app, const char *request_id, picker_callback callback,
    const char *picker_name) {
    picker_request *pending = calloc(1, sizeof(*pending));
    char *message = NULL;

    if (pending == NULL) {
        message = g_strdup_printf("Could not start the %s.", picker_name);
        return_native_error(app->view, request_id, "INTERNAL_ERROR", message);
        g_free(message);
        return 0;
    }

    pending->request_id = g_strdup(request_id);
    pending->app = app;
    if (pending->request_id == NULL || WEBVIEW_FAILED(webview_dispatch(app->view, callback, pending))) {
        g_free(pending->request_id);
        free(pending);
        message = g_strdup_printf("The %s could not be opened.", picker_name);
        return_native_error(app->view, request_id, "DISPATCH_ERROR", message);
        g_free(message);
        return 0;
    }
    return 1;
}
