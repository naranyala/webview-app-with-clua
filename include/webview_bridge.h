#ifndef WEBVIEW_BRIDGE_H
#define WEBVIEW_BRIDGE_H

#include <stddef.h>

typedef enum {
    BRIDGE_OK = 0,
    BRIDGE_ERR_NULL_RESPONSE = -1,
    BRIDGE_ERR_BUFFER_TOO_SMALL = -2,
    BRIDGE_ERR_NULL_REQUEST = -3,
    BRIDGE_ERR_OUT_OF_MEMORY = -4,
    BRIDGE_ERR_MALFORMED_REQUEST = -5,
    BRIDGE_ERR_EMPTY_INPUT = -6,
    BRIDGE_ERR_INVALID_VALUE = -7,
    BRIDGE_ERR_TRAILING_DATA = -8,
    BRIDGE_ERR_ENGINE_FAILED = -9,
} bridge_error;

/*
 * Parses the WebView binding request and writes a JSON response.
 *
 * The request is the webview library's serialized argument list:
 * [[number, number, ...]]. A successful response is a metrics summary;
 * invalid or empty input produces a JSON error response and returns 0.
 *
 * Returns BRIDGE_OK on success, or a negative bridge_error code.
 * On success, response contains the JSON result.
 * On failure, response contains a JSON error object (if buffer allows).
 */
bridge_error summarize_request(const char *request, char *response, size_t response_size);

/* Returns a human-readable string for a bridge_error code. */
const char *bridge_strerror(bridge_error error);

#endif
