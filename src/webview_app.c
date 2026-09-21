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

static int check_webview_error(const char *operation, webview_error_t error) {
    if (WEBVIEW_FAILED(error)) {
        fprintf(stderr, "WebView %s failed with error code %d.\n", operation, (int)error);
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
    int ok = summarize_request(request, response, sizeof(response));
    webview_return(app->view, id, ok ? 0 : 1, response);
}

static char *load_html(const char *path) {
    FILE *file = fopen(path, "rb");
    char *html;
    long length;
    if (file == NULL || fseek(file, 0, SEEK_END) != 0 || (length = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0) {
        if (file != NULL) fclose(file);
        return NULL;
    }
    html = malloc((size_t)length + 1);
    if (html == NULL || fread(html, 1, (size_t)length, file) != (size_t)length) {
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

    app.view = webview_create(METRICS_ENABLE_DEVTOOLS, NULL);
    if (app.view == NULL) {
        fprintf(stderr, "Could not create WebView. Check the graphical session and GTK/WebKit runtime dependencies (DISPLAY=%s, WAYLAND_DISPLAY=%s).\n",
                getenv("DISPLAY") != NULL ? getenv("DISPLAY") : "unset",
                getenv("WAYLAND_DISPLAY") != NULL ? getenv("WAYLAND_DISPLAY") : "unset");
        return 1;
    }
    if (!check_webview_error("set_title", webview_set_title(app.view, "C-powered Lua metrics"))) goto fail;
    {
        webview_error_t size_error = webview_set_size(app.view, 760, 540, WEBVIEW_HINT_NONE);
        if (WEBVIEW_FAILED(size_error)) {
            fprintf(stderr, "WebView set_size returned error code %d; continuing because the size was applied.\n", (int)size_error);
        }
    }
    if (!check_webview_error("bind summarize", webview_bind(app.view, "summarize", on_summarize, &app))) goto fail;
    if (!use_inline_html && frontend_url != NULL && *frontend_url != '\0') {
        if (!check_webview_error("navigate frontend URL", webview_navigate(app.view, frontend_url))) {
            fprintf(stderr, "Falling back to inline frontend HTML.\n");
            use_inline_html = 1;
        }
    } else if (!use_inline_html && build_file_url(APP_HTML_PATH, file_url, sizeof(file_url))) {
        if (!check_webview_error("navigate frontend file", webview_navigate(app.view, file_url))) {
            fprintf(stderr, "Falling back to inline frontend HTML.\n");
            use_inline_html = 1;
        }
    } else {
        use_inline_html = 1;
    }
    if (use_inline_html) {
        html = load_html(APP_HTML_PATH);
        if (html == NULL || !check_webview_error("set_html", webview_set_html(app.view, html))) goto fail;
    }
    if (!check_webview_error("run", webview_run(app.view))) goto fail;
    webview_destroy(app.view);
    free(html);
    return 0;

fail:
    webview_destroy(app.view);
    free(html);
    return 1;
}
