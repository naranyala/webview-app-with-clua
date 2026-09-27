/*
 * Shared plumbing for the desktop host: error replies, file URLs, picker
 * dispatch, and the GTK path chooser used by every picker-backed binding.
 * The JSON bytes themselves live in json_io.c.
 *
 * See include/app_support.h for the layer contract and ownership rules.
 */

#include "app_support.h"

#include "json_io.h"

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

/* --- JSON error replies --------------------------------------------------- */

/*
 * Rejects a request with the shared error shape used by every binding. The
 * frontend unwraps {error:{code,message}} into its status lines, so codes and
 * messages stay user-readable. The bytes are produced by json_io.c, which is
 * the only place in the process that knows how to write JSON.
 */
void return_native_error(webview_t view, const char *request_id, const char *code, const char *message) {
    GString *response = g_string_new(NULL);
    json_append_error(response, code, message);
    webview_return(view, request_id, 1, response->str);
    g_string_free(response, TRUE);
}

/* --- GTK path chooser ---------------------------------------------------- */

/*
 * Modal GTK chooser shared by every picker-backed binding. Returns the
 * selected path (caller frees) or NULL when the user cancelled.
 */
char *run_path_chooser(webview_t view, picker_kind kind, const char *title,
    const picker_filter *filter, const char *suggested_name) {
    GtkWindow *parent = webview_get_native_handle(view, WEBVIEW_NATIVE_HANDLE_KIND_UI_WINDOW);
    GtkFileChooserAction action;
    const char *accept_label;
    GtkWidget *dialog;
    GtkFileChooser *chooser;
    char *selected_path = NULL;

    if (kind == PICKER_SELECT_FOLDER) {
        action = GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER;
        accept_label = "_Select";
    } else if (kind == PICKER_SAVE_FILE) {
        action = GTK_FILE_CHOOSER_ACTION_SAVE;
        accept_label = "_Save";
    } else {
        action = GTK_FILE_CHOOSER_ACTION_OPEN;
        accept_label = "_Open";
    }

    dialog = gtk_file_chooser_dialog_new(
        title,
        parent,
        action,
        "_Cancel",
        GTK_RESPONSE_CANCEL,
        accept_label,
        GTK_RESPONSE_ACCEPT,
        NULL);
    chooser = GTK_FILE_CHOOSER(dialog);

    gtk_window_set_modal(GTK_WINDOW(dialog), TRUE);
    if (kind == PICKER_SAVE_FILE) {
        gtk_file_chooser_set_do_overwrite_confirmation(chooser, TRUE);
        if (suggested_name != NULL && suggested_name[0] != '\0') {
            gtk_file_chooser_set_current_name(chooser, suggested_name);
        }
    }
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
 * request itself and returns 0, which keeps reporting in one place. payload
 * (may be NULL) is transferred to the callback, which owns and frees it; it
 * is also freed here when dispatch fails.
 */
int dispatch_picker_with_payload(app_context *app, const char *request_id,
    picker_callback callback, const char *picker_name, char *payload) {
    picker_request *pending = calloc(1, sizeof(*pending));
    char *message = NULL;

    if (pending == NULL) {
        message = g_strdup_printf("Could not start the %s.", picker_name);
        return_native_error(app->view, request_id, "INTERNAL_ERROR", message);
        g_free(message);
        g_free(payload);
        return 0;
    }

    pending->request_id = g_strdup(request_id);
    pending->app = app;
    pending->payload = payload;
    if (pending->request_id == NULL || WEBVIEW_FAILED(webview_dispatch(app->view, callback, pending))) {
        picker_request_release(pending);
        message = g_strdup_printf("The %s could not be opened.", picker_name);
        return_native_error(app->view, request_id, "DISPATCH_ERROR", message);
        g_free(message);
        return 0;
    }
    return 1;
}

/*
 * Single owner for a picker_request and everything it holds. The request_id is
 * a g_strdup copy and the payload is a g_strdup copy too, so both go through
 * g_free; the struct itself came from malloc.
 */
void picker_request_release(picker_request *request) {
    if (request == NULL) return;
    g_free(request->request_id);
    g_free(request->payload);
    free(request);
}

int dispatch_picker(app_context *app, const char *request_id, picker_callback callback,
    const char *picker_name) {
    return dispatch_picker_with_payload(app, request_id, callback, picker_name, NULL);
}
