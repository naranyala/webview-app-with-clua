#include "metrics.h"
#include "webview_bridge.h"

#include <webview/webview.h>

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { webview_t view; } app_context;

#ifndef METRICS_ENABLE_DEVTOOLS
#define METRICS_ENABLE_DEVTOOLS 1
#endif

static const char *webview_error_name(webview_error_t error) {
    switch (error) {
        case WEBVIEW_ERROR_OK:                      return "OK";
        case WEBVIEW_ERROR_UNSPECIFIED:             return "UNSPECIFIED";
        case WEBVIEW_ERROR_INVALID_ARGUMENT:        return "INVALID_ARGUMENT";
        case WEBVIEW_ERROR_INVALID_STATE:           return "INVALID_STATE";
        case WEBVIEW_ERROR_INVALID_OPERATION:       return "INVALID_OPERATION";
        case WEBVIEW_ERROR_INVALID_STATE_DEVTOOLS:  return "INVALID_STATE_DEVTOOLS";
        case WEBVIEW_ERROR_NOT_FOUND:               return "NOT_FOUND";
        case WEBVIEW_ERROR_NO_STATE:                return "NO_STATE";
        case WEBVIEW_ERROR_MODULE_NOT_FOUND:        return "MODULE_NOT_FOUND";
        case WEBVIEW_ERROR_MODULE_SYMBOL_NOT_FOUND: return "MODULE_SYMBOL_NOT_FOUND";
        case WEBVIEW_ERROR_UNSPECIFIED_CREATE:      return "UNSPECIFIED_CREATE";
        case WEBVIEW_ERROR_UNSPECIFIED_INIT:        return "UNSPECIFIED_INIT";
        case WEBVIEW_ERROR_UNSPECIFIED_NAVIGATE:    return "UNSPECIFIED_NAVIGATE";
        case WEBVIEW_ERROR_UNSPECIFIED_WINDOW:      return "UNSPECIFIED_WINDOW";
        case WEBVIEW_ERROR_UNSPECIFIED_BIND:        return "UNSPECIFIED_BIND";
        case WEBVIEW_ERROR_UNSPECIFIED_UNBIND:      return "UNSPECIFIED_UNBIND";
        case WEBVIEW_ERROR_UNSPECIFIED_RETURN:      return "UNSPECIFIED_RETURN";
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
    webview_destroy(app.view);
    free(html);
    fprintf(stderr, "Exiting with code %d.\n", exit_code);
    return exit_code;
}
