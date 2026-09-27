#ifndef APP_SUPPORT_H
#define APP_SUPPORT_H

/*
 * Shared plumbing for the desktop host (layer 1 of the native app).
 *
 * Every native binding in this process runs against one app_context, answers
 * with the same JSON error shape, and opens file dialogs through the same
 * GTK chooser. Keeping that plumbing here lets the concern modules
 * (pdf_session, image_directory, workspace_bindings) depend on a small, stable
 * surface instead of on each other.
 *
 * Ownership rules used across the app:
 *   - Functions returning char * hand the caller ownership (free with g_free
 *     or free, exactly as documented on each declaration).
 */

#include <stddef.h>

#include <glib.h>
#include <webview/webview.h>

/* Long-lived state shared by every native binding. Owned by main(). */
typedef struct {
    webview_t view;
    char *pdf_path;
    char *pdf_id;
    char *pdf_fingerprint;
    GThread *pdf_toc_thread;
    /* Exit code forced by the smoke verdict; 0 leaves main()'s own code alone. */
    int exit_code_override;
} app_context;

/* How a path chooser should behave: open one file, save one, or pick a directory. */
typedef enum {
    PICKER_OPEN_FILE,
    PICKER_SELECT_FOLDER,
    PICKER_SAVE_FILE
} picker_kind;

/* Optional GTK filter applied to the chooser (name, pattern, MIME). */
typedef struct {
    const char *filter_name;
    const char *filter_pattern;
    const char *filter_mime;
} picker_filter;

/* Heap payload handed to webview_dispatch() when a picker starts. */
typedef struct {
    char *request_id;
    app_context *app;
    /*
     * Optional raw copy of the binding request, owned by the callback.
     * Text transfers stash their decoded-later arguments here; PDF and image
     * pickers leave it NULL.
     */
    char *payload;
} picker_request;

/*
 * Signature of the routine that runs on the GTK main loop once the chooser
 * has been dispatched. It receives the view and the picker_request it must
 * free when the answer has been delivered.
 */
typedef void (*picker_callback)(webview_t view, void *argument);

/*
 * Rejects a pending webview request with the shared error shape
 * {"error":{"code":"...","message":"..."}} written by json_io.c. This is the
 * only supported way for a binding to fail: a rejected promise keeps the
 * frontend report path working.
 */
void return_native_error(webview_t view, const char *request_id, const char *code, const char *message);

/* Builds a percent-encoded file:// URL. Returns 1 on success, 0 if it does not fit. */
int build_file_url(const char *path, char *url, size_t url_size);

/*
 * Opens a modal GTK chooser and returns the selected path (caller frees), or
 * NULL when the user cancelled. suggested_name seeds the file name of a
 * PICKER_SAVE_FILE chooser (ignored for the other kinds). Runs on the GTK
 * main loop only.
 */
char *run_path_chooser(webview_t view, picker_kind kind, const char *title,
    const picker_filter *filter, const char *suggested_name);

/*
 * Marshals a picker onto the GTK main loop. Returns 1 when the callback was
 * scheduled; on failure it rejects the request itself and returns 0, so
 * callers never have to report twice.
 */
int dispatch_picker(app_context *app, const char *request_id, picker_callback callback, const char *picker_name);

/*
 * Same contract as dispatch_picker(), with an optional payload (ownership
 * transferred to the callback on success, freed here on failure).
 */
int dispatch_picker_with_payload(app_context *app, const char *request_id,
    picker_callback callback, const char *picker_name, char *payload);

/*
 * Releases a picker_request and everything it owns, including the optional
 * payload. Every picker callback must hand its request to this instead of
 * freeing the fields by hand, so a payload can never be leaked.
 */
void picker_request_release(picker_request *request);

#endif /* APP_SUPPORT_H */
