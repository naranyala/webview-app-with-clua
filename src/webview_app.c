/*
 * Desktop host entry point (layer 4: composition).
 *
 * This file is deliberately small: it creates the webview, registers every
 * native binding, and decides how the frontend HTML reaches the page
 * (external dev URL, file:// URL, or inline set_html fallback). The work each
 * binding performs lives in its own module:
 *
 *   json_io.c             the single JSON writer and request reader
 *   app_support.c         error replies, file URLs, picker dispatch, chooser
 *   pdf_toc.c             PDF heading extraction, cache, serialization
 *   pdf_session.c         openPdf + extractPdfToc bindings
 *   image_directory.c     openImageDirectory binding
 *   smoke.c               smokeVerdict verdict reporting for the smoke runner
 *   workspace_bindings.c  loadWorkspace + saveWorkspace bindings
 *   text_transfer.c       openTextFile + saveTextFile bindings
 *   webview_bridge.c      summarize payload parsing and formatting
 *   workspace_store.c     durable workspace file access
 */

#include "app_support.h"
#include "image_directory.h"
#include "metrics.h"
#include "pdf_session.h"
#include "smoke.h"
#include "text_transfer.h"
#include "webview_bridge.h"
#include "workspace_bindings.h"
#include "workspace_store.h"

#include <glib.h>
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
        return_native_error(app->view, id, "NULL_REQUEST", "No request data received.");
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
        return_native_error(app->view, id, "INTERNAL_ERROR", "Response could not be generated.");
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

/*
 * Reads the bundled index.html into a NUL-terminated buffer (caller frees).
 * g_file_get_contents does the reading, and set_html embeds the result
 * verbatim, so a bundle containing NUL bytes is refused rather than silently
 * cut short.
 */
static char *load_html(const char *path) {
    char *html = NULL;
    gsize length = 0;
    GError *error = NULL;

    if (path == NULL) {
        fprintf(stderr, "load_html: path is NULL\n");
        return NULL;
    }

    if (!g_file_get_contents(path, &html, &length, &error)) {
        fprintf(stderr, "load_html: cannot read '%s': %s\n", path,
            error != NULL ? error->message : "unknown error");
        g_clear_error(&error);
        return NULL;
    }

    if (memchr(html, '\0', length) != NULL) {
        fprintf(stderr, "load_html: '%s' contains a NUL byte\n", path);
        g_free(html);
        return NULL;
    }

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

    /* Smoke mode: flag the page before its scripts run (see scripts/smoke.sh). */
    {
        const char *smoke_script = smoke_init_script();
        if (smoke_script != NULL &&
            !check_webview_error("init smoke marker", webview_init(app.view, smoke_script)))
            goto fail;
    }

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

    if (!check_webview_error("bind openTextFile", webview_bind(app.view, "openTextFile", on_open_text_file, &app)))
        goto fail;

    if (!check_webview_error("bind saveTextFile", webview_bind(app.view, "saveTextFile", on_save_text_file, &app)))
        goto fail;

    /* Only bound during a smoke run, so the frontend cannot call it otherwise. */
    if (smoke_enabled() &&
        !check_webview_error("bind smokeVerdict", webview_bind(app.view, "smokeVerdict", on_smoke_verdict, &app)))
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
    exit_code = app.exit_code_override;

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
