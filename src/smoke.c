/*
 * Smoke-run plumbing behind the smokeVerdict binding.
 *
 * See include/smoke.h for the contract. The host side is intentionally tiny:
 * the frontend runs the checks, sends one verdict, and this module turns that
 * into a log line and an exit code. A run that never reports simply keeps the
 * window open, which is why scripts/smoke.sh always launches it under a
 * timeout.
 */

#include "smoke.h"

#include "json_io.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- mode detection (pure) ----------------------------------------------- */

int smoke_enabled(void) {
    const char *value = getenv("METRICS_SMOKE");
    return value != NULL && *value != '\0' && strcmp(value, "0") != 0;
}

int smoke_writable(void) {
    const char *data_home = getenv("XDG_DATA_HOME");
    return data_home != NULL && *data_home != '\0';
}

/*
 * Two ready-made fragments instead of string building: the marker must be
 * injected before the page scripts, so it stays a constant.
 */
static const char smoke_marker_script[] =
    "window.__METRICS_SMOKE__=1;";
static const char smoke_marker_writable_script[] =
    "window.__METRICS_SMOKE__=1;window.__METRICS_SMOKE_WRITABLE__=1;";

const char *smoke_init_script(void) {
    if (!smoke_enabled()) {
        return NULL;
    }
    return smoke_writable() ? smoke_marker_writable_script : smoke_marker_script;
}

/* --- request decoding (pure) ---------------------------------------------- */

/*
 * Decodes ["1"|"0", "report"] through the shared codec, so the verdict obeys
 * the same grammar as every other binding request: escapes are understood, a
 * raw control byte is rejected, and nothing may follow the closing bracket.
 * The flag itself is still checked here, because only the host decides what a
 * passing verdict looks like.
 */
int smoke_decode_verdict(const char *request, int *pass, char **report) {
    json_result status;
    char *values[2] = {NULL, NULL};
    int decoded;

    if (report != NULL) *report = NULL;
    if (pass == NULL || report == NULL) return 0;
    if (request == NULL) return 0;

    status = json_read_string_array(request, 2, values, NULL);
    if (status != JSON_OK) {
        json_free_values(values, 2);
        return 0;
    }

    if (strcmp(values[0], "1") == 0) {
        decoded = 1;
    } else if (strcmp(values[0], "0") == 0) {
        decoded = 0;
    } else {
        json_free_values(values, 2);
        return 0;
    }

    free(values[0]);
    *pass = decoded;
    *report = values[1];
    return 1;
}

/* --- binding -------------------------------------------------------------- */

/*
 * Collapses the report to one line: the verdict is greppable from a captured
 * log, and a stray newline must not fake a second verdict line.
 */
static void flatten_report(char *report) {
    for (char *cursor = report; *cursor != '\0'; cursor++) {
        if (*cursor == '\n' || *cursor == '\r' || *cursor == '\t') {
            *cursor = ' ';
        }
    }
}

void on_smoke_verdict(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    int pass = 0;
    char *report = NULL;

    if (id == NULL) {
        fprintf(stderr, "smokeVerdict: received no request id, ignoring\n");
        return;
    }

    if (!smoke_decode_verdict(request, &pass, &report)) {
        fprintf(stderr, "smokeVerdict: malformed request: %s\n",
                request == NULL ? "(null)" : request);
        return_native_error(app->view, id, "INVALID_ARGUMENT",
            "smokeVerdict expects [\"1\"|\"0\", \"report\"].");
        return;
    }

    flatten_report(report);

    /* stdout is the machine-readable channel; the app logs go to stderr. */
    printf("SMOKE VERDICT pass=%d report=%s\n", pass, report);
    fflush(stdout);
    fprintf(stderr, "smokeVerdict: recorded pass=%d\n", pass);

    app->exit_code_override = pass ? 0 : 1;
    free(report);

    if (WEBVIEW_FAILED(webview_return(app->view, id, 0, "{\"ok\":true}"))) {
        fprintf(stderr, "smokeVerdict: could not acknowledge the verdict\n");
    }

    /* terminate() only flags the run loop, so calling it here is safe. */
    if (WEBVIEW_FAILED(webview_terminate(app->view))) {
        fprintf(stderr, "smokeVerdict: could not terminate the event loop\n");
    }
}
