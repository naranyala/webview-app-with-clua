/*
 * Desktop host entry point (layer 4: composition).
 *
 * This file is deliberately small: it creates the webview, registers every
 * native binding, and decides how the frontend HTML reaches the page
 * (external dev URL, file:// URL, or inline set_html fallback). The work each
 * binding performs lives in its own module:
 *
 *   app_support.c         JSON/errors, file URLs, GTK path chooser
 *   pdf_toc.c             PDF heading extraction, cache, serialization
 *   pdf_session.c         openPdf + extractPdfToc bindings
 *   image_directory.c     openImageDirectory binding
 *   workspace_bindings.c  loadWorkspace + saveWorkspace bindings
 *   webview_bridge.c      summarize payload parsing and formatting
 *   workspace_store.c     durable workspace file access
 */

#include "app_support.h"
#include "image_directory.h"
#include "metrics.h"
#include "pdf_session.h"
#include "webview_bridge.h"
#include "workspace_bindings.h"
#include "workspace_store.h"

#include <gtk/gtk.h>
#include <webview/webview.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef METRICS_ENABLE_DEVTOOLS
#define METRICS_ENABLE_DEVTOOLS 1
#endif

/* --- webview error reporting --------------------------------------------- */

/* Maps webview_error_t to a stable name used in logs and warnings. */
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

/* Returns 1 on success; on failure it logs the operation and returns 0. */
static int check_webview_error(const char *operation, webview_error_t error) {
    if (WEBVIEW_FAILED(error)) {
        fprintf(stderr, "WebView %s failed: error=%s (%d).\n",
                operation, webview_error_name(error), (int)error);
        return 0;
    }
    return 1;
}

/* --- summarize binding ---------------------------------------------------- */

/*
 * Binds "summarize": parses the request with webview_bridge, formats the
 * reply into a fixed buffer, and resolves or rejects with the shared shape.
 */
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

/* --- frontend bootstrap --------------------------------------------------- */

/*
 * Injected before the page scripts run. It paints an on-page box for any
 * window error or unhandled rejection, so a broken bundle is visible without
 * a debugger attached.
 */
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

/* Reads the bundled index.html into a NUL-terminated buffer (caller frees). */
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

/* --- entry point ---------------------------------------------------------- */

/*
 * Creates the window, binds every native command, and loads the frontend.
 * Render mode is chosen with METRICS_RENDER_MODE (file by default, "inline"
 * forces set_html) and METRICS_FRONTEND_URL overrides the target for dev.
 */
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

    /* Native bindings: one per frontend call, each in its owning module. */
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
