#include "webview_bridge.h"

#include "metrics.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>

static const char *skip_space(const char *cursor) {
    while (isspace((unsigned char)*cursor)) cursor++;
    return cursor;
}

static int has_newline(const char *from, const char *to) {
    for (const char *p = from; p < to; p++) {
        if (*p == '\n' || *p == '\r') return 1;
    }
    return 0;
}

static int write_error(char *response, size_t response_size, const char *code, const char *message) {
    int written = snprintf(response, response_size,
                            "{\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}",
                            code, message);
    if (written < 0 || (size_t)written >= response_size) {
        if (response_size > 0) response[0] = '\0';
        return 0;
    }
    return 1;
}

static int write_summary(char *response, size_t response_size, const metrics_summary *summary) {
    int written = snprintf(response, response_size,
                            "{\"count\":%zu,\"sum\":%.17g,\"min\":%.17g,\"max\":%.17g,\"mean\":%.17g,\"variance\":%.17g}",
                            summary->count, summary->sum, summary->min, summary->max,
                            summary->mean, summary->variance);
    if (written < 0 || (size_t)written >= response_size) {
        if (response_size > 0) response[0] = '\0';
        return 0;
    }
    return 1;
}

static bridge_error parse_number_array(const char **cursor_ref, metrics_engine *engine) {
    const char *cursor = *cursor_ref;
    int first = 1;

    for (;;) {
        char *end;
        double value;
        metrics_error merr;
        const char *before_space;

        /* Skip whitespace including newlines */
        before_space = cursor;
        cursor = skip_space(cursor);

        /* Check for end of array */
        if (*cursor == ']') break;

        /* If not the first element, expect a comma or newline separator */
        if (!first) {
            if (*cursor == ',') {
                cursor++;
                cursor = skip_space(cursor);
            } else if (!has_newline(before_space, cursor)) {
                /* No comma and no newline — missing separator */
                return BRIDGE_ERR_MALFORMED_REQUEST;
            }
            /* Newline was present — valid implicit separator */
        }
        first = 0;

        /* Parse a number */
        value = strtod(cursor, &end);
        if (end == cursor) return BRIDGE_ERR_MALFORMED_REQUEST;
        cursor = end;

        /* Add the number to the engine */
        merr = metrics_add(engine, value);
        if (merr == METRICS_ERR_NON_FINITE) return BRIDGE_ERR_INVALID_VALUE;
        if (merr != METRICS_OK) return BRIDGE_ERR_ENGINE_FAILED;
    }

    *cursor_ref = cursor;
    return BRIDGE_OK;
}

bridge_error summarize_request(const char *request, char *response, size_t response_size) {
    const char *cursor;
    metrics_engine *engine;
    metrics_summary summary;
    bridge_error err;

    if (response == NULL || response_size == 0) return BRIDGE_ERR_NULL_RESPONSE;
    response[0] = '\0';

    if (request == NULL) {
        write_error(response, response_size, "INVALID_REQUEST", "Request must not be null.");
        return BRIDGE_ERR_NULL_REQUEST;
    }

    engine = metrics_create();
    if (engine == NULL) {
        write_error(response, response_size, "OUT_OF_MEMORY", "Could not allocate a metrics engine.");
        return BRIDGE_ERR_OUT_OF_MEMORY;
    }

    cursor = skip_space(request);

    /* Expect outer array: [ ... ] */
    if (*cursor != '[') {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Request must be a JSON array: [[number, ...]].");
        err = BRIDGE_ERR_MALFORMED_REQUEST;
        goto done;
    }
    cursor++;
    cursor = skip_space(cursor);

    /* Expect inner array: [ ... ] */
    if (*cursor != '[') {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Request must contain an inner array of numbers: [[number, ...]].");
        err = BRIDGE_ERR_MALFORMED_REQUEST;
        goto done;
    }
    cursor++;
    cursor = skip_space(cursor);

    /* Handle empty inner array */
    if (*cursor == ']') {
        write_error(response, response_size, "EMPTY_INPUT",
                    "The inner array must contain at least one finite number.");
        err = BRIDGE_ERR_EMPTY_INPUT;
        goto done;
    }

    /* Parse the number array */
    err = parse_number_array(&cursor, engine);
    if (err == BRIDGE_ERR_MALFORMED_REQUEST) {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Expected a comma-separated list of finite numbers.");
        goto done;
    }
    if (err == BRIDGE_ERR_INVALID_VALUE) {
        write_error(response, response_size, "INVALID_VALUE",
                    "Every value must be finite (not NaN or infinity) and within the numeric range.");
        goto done;
    }
    if (err != BRIDGE_OK) {
        write_error(response, response_size, "ENGINE_FAILED",
                    "The metrics engine rejected one or more values.");
        goto done;
    }

    /* Close inner array */
    if (*cursor != ']') {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Expected closing bracket for inner array.");
        err = BRIDGE_ERR_MALFORMED_REQUEST;
        goto done;
    }
    cursor++;
    cursor = skip_space(cursor);

    /* Close outer array */
    if (*cursor != ']') {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Expected closing bracket for outer array.");
        err = BRIDGE_ERR_MALFORMED_REQUEST;
        goto done;
    }
    cursor++;
    cursor = skip_space(cursor);

    /* No trailing data allowed */
    if (*cursor != '\0') {
        write_error(response, response_size, "INVALID_REQUEST",
                    "Unexpected trailing data after the array.");
        err = BRIDGE_ERR_TRAILING_DATA;
        goto done;
    }

    /* Get the summary */
    {
        metrics_error merr = metrics_get_summary(engine, &summary);
        if (merr != METRICS_OK) {
            write_error(response, response_size, "EMPTY_INPUT",
                        "The inner array must contain at least one finite number.");
            err = BRIDGE_ERR_EMPTY_INPUT;
            goto done;
        }
    }

    /* Write the successful response */
    if (!write_summary(response, response_size, &summary)) {
        write_error(response, response_size, "BUFFER_TOO_SMALL",
                    "Response buffer is too small to hold the result.");
        err = BRIDGE_ERR_BUFFER_TOO_SMALL;
        goto done;
    }

    err = BRIDGE_OK;

done:
    metrics_destroy(engine);
    return err;
}

const char *bridge_strerror(bridge_error error) {
    switch (error) {
        case BRIDGE_OK:                  return "success";
        case BRIDGE_ERR_NULL_RESPONSE:   return "response buffer is NULL";
        case BRIDGE_ERR_BUFFER_TOO_SMALL:return "response buffer is too small";
        case BRIDGE_ERR_NULL_REQUEST:    return "request string is NULL";
        case BRIDGE_ERR_OUT_OF_MEMORY:   return "memory allocation failed";
        case BRIDGE_ERR_MALFORMED_REQUEST:return "request is not valid JSON or has wrong structure";
        case BRIDGE_ERR_EMPTY_INPUT:     return "input array is empty";
        case BRIDGE_ERR_INVALID_VALUE:   return "input contains non-finite or out-of-range values";
        case BRIDGE_ERR_TRAILING_DATA:   return "unexpected data after the JSON array";
        case BRIDGE_ERR_ENGINE_FAILED:   return "metrics engine rejected a value";
    }
    return "unknown error";
}
