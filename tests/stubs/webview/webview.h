/*
 * Test-only stand-in for the real webview header.
 *
 * The unit tests compile app_support.c (JSON errors, file URLs, picker
 * dispatch) without pulling in the WebView library or its platform headers.
 * The declarations below mirror webview 0.12 exactly - types, constness and
 * enum names - so definitions written against this header also match the real
 * one when the desktop target builds. Every test that links app_support.c
 * must define the three functions itself.
 *
 * Source of truth: build/desktop/_deps/webview-src/core/include/webview/webview.h
 */

#ifndef WEBVIEW_H
#define WEBVIEW_H

/* Pointer to a webview instance. */
typedef void *webview_t;

/* Native handle kind. The actual type depends on the backend. */
typedef enum {
  WEBVIEW_NATIVE_HANDLE_KIND_UI_WINDOW,
  WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET,
  WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER
} webview_native_handle_kind_t;

/* Error codes returned by the API; failures are negative. */
typedef enum {
  WEBVIEW_ERROR_MISSING_DEPENDENCY = -5,
  WEBVIEW_ERROR_CANCELED = -4,
  WEBVIEW_ERROR_INVALID_STATE = -3,
  WEBVIEW_ERROR_INVALID_ARGUMENT = -2,
  WEBVIEW_ERROR_UNSPECIFIED = -1,
  WEBVIEW_ERROR_OK = 0,
  WEBVIEW_ERROR_DUPLICATE = 1,
  WEBVIEW_ERROR_NOT_FOUND = 2
} webview_error_t;

/* Evaluates to TRUE if the given webview error indicates failure. */
#define WEBVIEW_FAILED(error) ((int)(error) < 0)

/* Schedules a function on the run/event loop of the host. */
webview_error_t webview_dispatch(webview_t w, void (*fn)(webview_t w, void *arg), void *arg);

/* Stops the run loop so the host can exit on its own. */
webview_error_t webview_terminate(webview_t w);

/* Returns the native handle of the requested kind, or NULL. */
void *webview_get_native_handle(webview_t w, webview_native_handle_kind_t kind);

/* Answers a pending binding call: status 0 resolves, non-zero rejects. */
webview_error_t webview_return(webview_t w, const char *id, int status, const char *result);

#endif /* WEBVIEW_H */
