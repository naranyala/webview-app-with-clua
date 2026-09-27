/*
 * Unit tests for smoke.c: the mode markers, the strict verdict decoder, and
 * the smokeVerdict binding. The webview calls are recorded by the same stubs
 * as the other host tests (tests/stubs/webview), so the verdict, the recorded
 * exit code, and the loop shutdown are all asserted without a GUI.
 */

#include "smoke.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- recorded webview stubs -------------------------------------------- */

static int recorded_returns;
static char recorded_id[128];
static int recorded_status;
static char recorded_result[512];
static int recorded_terminates;
static webview_error_t terminate_reply = WEBVIEW_ERROR_OK;

webview_error_t webview_return(webview_t view, const char *id, int status, const char *result) {
    (void)view;
    recorded_returns++;
    snprintf(recorded_id, sizeof(recorded_id), "%s", id != NULL ? id : "");
    recorded_status = status;
    snprintf(recorded_result, sizeof(recorded_result), "%s", result != NULL ? result : "");
    return WEBVIEW_ERROR_OK;
}

webview_error_t webview_dispatch(webview_t view, void (*fn)(webview_t, void *), void *argument) {
    (void)view;
    (void)fn;
    (void)argument;
    return WEBVIEW_ERROR_OK;
}

webview_error_t webview_terminate(webview_t view) {
    (void)view;
    recorded_terminates++;
    return terminate_reply;
}

void *webview_get_native_handle(webview_t view, webview_native_handle_kind_t kind) {
    (void)view;
    (void)kind;
    return NULL;
}

static void reset_recordings(void) {
    recorded_returns = 0;
    recorded_id[0] = '\0';
    recorded_status = 0;
    recorded_result[0] = '\0';
    recorded_terminates = 0;
    terminate_reply = WEBVIEW_ERROR_OK;
    g_unsetenv("METRICS_SMOKE");
    g_unsetenv("XDG_DATA_HOME");
}

/* --- mode detection ------------------------------------------------------ */

static void test_smoke_disabled_by_default(void) {
    reset_recordings();

    assert(smoke_enabled() == 0);
    assert(smoke_writable() == 0);
    assert(smoke_init_script() == NULL);
}

static void test_smoke_marker_variants(void) {
    reset_recordings();
    g_setenv("METRICS_SMOKE", "1", TRUE);
    assert(smoke_enabled() == 1);

    /* Without an explicit data home the run must stay read-only. */
    const char *marker = smoke_init_script();
    assert(marker != NULL);
    assert(strstr(marker, "__METRICS_SMOKE__=1") != NULL);
    assert(strstr(marker, "__METRICS_SMOKE_WRITABLE__") == NULL);

    g_setenv("XDG_DATA_HOME", "/tmp/opencode/smoke", TRUE);
    assert(smoke_writable() == 1);
    marker = smoke_init_script();
    assert(marker != NULL);
    assert(strstr(marker, "__METRICS_SMOKE_WRITABLE__=1") != NULL);
}

static void test_smoke_env_edge_values(void) {
    reset_recordings();

    g_setenv("METRICS_SMOKE", "0", TRUE);
    assert(smoke_enabled() == 0);
    assert(smoke_init_script() == NULL);

    g_setenv("METRICS_SMOKE", "", TRUE);
    assert(smoke_enabled() == 0);

    g_setenv("XDG_DATA_HOME", "", TRUE);
    assert(smoke_writable() == 0);
}

/* --- verdict decoding ---------------------------------------------------- */

static void test_decode_valid_verdicts(void) {
    int pass = -1;
    char *report = NULL;

    assert(smoke_decode_verdict("[\"1\",\"checks=4/4\"]", &pass, &report) == 1);
    assert(pass == 1);
    assert(strcmp(report, "checks=4/4") == 0);
    free(report);

    assert(smoke_decode_verdict("[\"0\", \"\"]", &pass, &report) == 1);
    assert(pass == 0);
    assert(strcmp(report, "") == 0);
    free(report);

    /* Whitespace tolerance matches the other request decoders. */
    assert(smoke_decode_verdict("  [\t\"1\"\n , \"ok\" ]  ", &pass, &report) == 1);
    assert(pass == 1);
    assert(strcmp(report, "ok") == 0);
    free(report);

    /*
     * Escapes are decoded exactly like every other binding request, and the
     * binding flattens the result so the verdict stays one greppable line.
     */
    assert(smoke_decode_verdict("[\"1\",\"a\\nb\"]", &pass, &report) == 1);
    assert(strcmp(report, "a\nb") == 0);
    free(report);

    /* A report may contain ordinary punctuation. */
    assert(smoke_decode_verdict("[\"1\",\"failed: b (line one line two)\"]", &pass, &report) == 1);
    assert(strcmp(report, "failed: b (line one line two)") == 0);
    free(report);
}

static void test_decode_rejects_bad_verdicts(void) {
    static const char *bad[] = {
        NULL,
        "",
        "[]",
        "[\"1\"]",
        "[\"1\",\"ok\"] extra",
        "[\"1\",\"ok\"",
        "[\t1,\"ok\"]",
        "[\"2\",\"ok\"]",
        "[\"true\",\"ok\"]",
        "[1,\"ok\"]",
        "[\"1\",ok]",
        "[\"1\",\"tab\there\"]",
        "not json at all",
    };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); i++) {
        int pass = -1;
        char *report = (char *)0x1;
        assert(smoke_decode_verdict(bad[i], &pass, &report) == 0);
        assert(report == NULL);
    }

    /* Output pointers are mandatory. */
    int pass = -1;
    char *report = NULL;
    assert(smoke_decode_verdict("[\"1\",\"ok\"]", NULL, &report) == 0);
    assert(report == NULL);
    assert(smoke_decode_verdict("[\"1\",\"ok\"]", &pass, NULL) == 0);
}

/* --- the binding --------------------------------------------------------- */

static void test_verdict_passes_and_terminates(void) {
    app_context app = {0};
    reset_recordings();
    app.view = NULL;

    on_smoke_verdict("req-1", "[\"1\",\"checks=4/4\"]", &app);

    assert(recorded_returns == 1);
    assert(strcmp(recorded_id, "req-1") == 0);
    assert(recorded_status == 0);
    assert(strcmp(recorded_result, "{\"ok\":true}") == 0);
    assert(recorded_terminates == 1);
    assert(app.exit_code_override == 0);
}

static void test_failed_verdict_forces_a_nonzero_exit(void) {
    app_context app = {0};
    reset_recordings();

    on_smoke_verdict("req-2", "[\"0\",\"checks=3/4 failed: dom-anchors\"]", &app);

    assert(recorded_returns == 1);
    assert(recorded_terminates == 1);
    assert(app.exit_code_override == 1);
}

/* An escaped newline in the report must not produce a second verdict line. */
static void test_report_is_flattened_to_one_line(void) {
    app_context app = {0};
    reset_recordings();

    on_smoke_verdict("req-5", "[\"1\",\"first\\nsecond\\tthird\"]", &app);

    assert(recorded_returns == 1);
    assert(app.exit_code_override == 0);
}

static void test_malformed_verdict_is_rejected_without_terminating(void) {
    app_context app = {0};
    reset_recordings();

    on_smoke_verdict("req-3", "[\"maybe\",\"ok\"]", &app);

    assert(recorded_returns == 1);
    assert(recorded_status != 0);
    assert(strstr(recorded_result, "INVALID_ARGUMENT") != NULL);
    assert(recorded_terminates == 0);
    assert(app.exit_code_override == 0);
}

static void test_missing_request_id_is_ignored(void) {
    app_context app = {0};
    reset_recordings();

    on_smoke_verdict(NULL, "[\"1\",\"ok\"]", &app);

    assert(recorded_returns == 0);
    assert(recorded_terminates == 0);
    assert(app.exit_code_override == 0);
}

static void test_failed_termination_is_survivable(void) {
    app_context app = {0};
    reset_recordings();
    terminate_reply = WEBVIEW_ERROR_UNSPECIFIED;

    on_smoke_verdict("req-4", "[\"1\",\"ok\"]", &app);

    assert(recorded_returns == 1);
    assert(recorded_terminates == 1);
    assert(app.exit_code_override == 0);
}

int main(void) {
    test_smoke_disabled_by_default();
    test_smoke_marker_variants();
    test_smoke_env_edge_values();

    test_decode_valid_verdicts();
    test_decode_rejects_bad_verdicts();

    test_verdict_passes_and_terminates();
    test_failed_verdict_forces_a_nonzero_exit();
    test_report_is_flattened_to_one_line();
    test_malformed_verdict_is_rejected_without_terminating();
    test_missing_request_id_is_ignored();
    test_failed_termination_is_survivable();

    printf("All smoke tests passed\n");
    return 0;
}
