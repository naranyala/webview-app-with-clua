#ifndef WEBVIEW_BRIDGE_H
#define WEBVIEW_BRIDGE_H

#include <stddef.h>

/*
 * Parses the WebView binding request and writes a JSON response.
 *
 * The request is the webview library's serialized argument list:
 * [[number, number, ...]]. A successful response is a metrics summary;
 * invalid or empty input produces a JSON error response and returns 0. Error
 * responses have the shape {"error":{"code":"...","message":"..."}}.
 */
int summarize_request(const char *request, char *response, size_t response_size);

#endif
