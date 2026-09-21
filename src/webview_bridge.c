#include "webview_bridge.h"

#include "metrics.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>

static const char *skip_space(const char *cursor) {
    while (isspace((unsigned char)*cursor)) cursor++;
    return cursor;
}

static void write_error(char *response, size_t response_size, const char *code, const char *message) {
    snprintf(response, response_size,
             "{\"error\":{\"code\":\"%s\",\"message\":\"%s\"}}",
             code, message);
}

int summarize_request(const char *request, char *response, size_t response_size) {
    const char *cursor;
    metrics_engine *engine;
    metrics_summary summary;
    const char *error_code = "INVALID_REQUEST";
    const char *error_message = "Send one non-empty array of finite numbers.";
    int ok = 0;

    if (response == NULL || response_size == 0) return 0;
    if (request == NULL) {
        write_error(response, response_size, error_code, error_message);
        return 0;
    }
    cursor = skip_space(request);
    engine = metrics_create();
    if (engine == NULL) {
        write_error(response, response_size, "OUT_OF_MEMORY", "Could not allocate a metrics engine.");
        return 0;
    }
    if (*cursor++ != '[') goto done;
    cursor = skip_space(cursor);
    if (*cursor++ != '[') goto done;
    cursor = skip_space(cursor);

    if (*cursor == ']') {
        error_code = "EMPTY_INPUT";
        error_message = "Send a non-empty array of finite numbers.";
        goto done;
    }
    for (;;) {
        char *end;
        double value = strtod(cursor, &end);
        if (end == cursor) goto done;
        if (metrics_add(engine, value) != 0) {
            error_code = "INVALID_VALUE";
            error_message = "Every value must be finite and within the numeric range.";
            goto done;
        }
        cursor = skip_space(end);
        if (*cursor == ']') break;
        if (*cursor++ != ',') goto done;
        cursor = skip_space(cursor);
    }
    cursor++;
    cursor = skip_space(cursor);
    if (*cursor++ != ']') goto done;
    cursor = skip_space(cursor);
    if (*cursor != '\0') goto done;
    if (metrics_get_summary(engine, &summary) != 0) {
        error_code = "EMPTY_INPUT";
        error_message = "Send a non-empty array of finite numbers.";
        goto done;
    }

    snprintf(response, response_size,
             "{\"count\":%zu,\"sum\":%.17g,\"min\":%.17g,\"max\":%.17g,\"mean\":%.17g,\"variance\":%.17g}",
             summary.count, summary.sum, summary.min, summary.max, summary.mean, summary.variance);
    ok = 1;

done:
    metrics_destroy(engine);
    if (!ok) write_error(response, response_size, error_code, error_message);
    return ok;
}
