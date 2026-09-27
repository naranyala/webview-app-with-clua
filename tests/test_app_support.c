/*
 * Unit tests for app_support.c: file URL building, JSON escaping, the shared
 * {"error":{code,message}} reply, and picker dispatch.
 *
 * The webview calls are replaced by recording stubs (see tests/stubs/webview),
 * so the failure shape the frontend unwraps is asserted without a GUI. GTK is
 * linked only because run_path_chooser() shares this translation unit; the
 * chooser itself never runs here.
 */

#include "app_support.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- recorded webview stubs -------------------------------------------- */

static int recorded_returns;
static char recorded_id[128];
static int recorded_status;
static char recorded_result[512];

static int recorded_dispatches;
static void (*dispatched_callback)(webview_t, void *);
static void *dispatched_argument;
static webview_error_t dispatch_reply = WEBVIEW_ERROR_OK;
static int recorded_handle_kind;

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
    recorded_dispatches++;
    dispatched_callback = fn;
    dispatched_argument = argument;
    return dispatch_reply;
}

void *webview_get_native_handle(webview_t view, webview_native_handle_kind_t kind) {
    (void)view;
    recorded_handle_kind = (int)kind;
    return NULL;
}

/* --- helpers ------------------------------------------------------------ */

static void assert_string_equals(const char *actual, const char *expected) {
    assert(actual != NULL);
    if (strcmp(actual, expected) != 0) {
        fprintf(stderr, "expected: %s\nactual:   %s\n", expected, actual);
        assert(0);
    }
}

static int string_contains(const char *text, const char *needle) {
    return text != NULL && strstr(text, needle) != NULL;
}

static void reset_recordings(void) {
    recorded_returns = 0;
    recorded_id[0] = '\0';
    recorded_status = -1;
    recorded_result[0] = '\0';
    recorded_dispatches = 0;
    dispatched_callback = NULL;
    dispatched_argument = NULL;
    dispatch_reply = WEBVIEW_ERROR_OK;
    recorded_handle_kind = -1;
}

/* --- file URLs ---------------------------------------------------------- */

static void test_build_file_url(void) {
    char url[256];
    char small[16];
    char tiny[8];

    assert(build_file_url("/home/user/report.pdf", url, sizeof(url)) == 1);
    assert_string_equals(url, "file:///home/user/report.pdf");

    /* Spaces, UTF-8 and other unsafe bytes are percent-encoded. */
    assert(build_file_url("/tmp/a b.pdf", url, sizeof(url)) == 1);
    assert_string_equals(url, "file:///tmp/a%20b.pdf");
    assert(build_file_url("/tmp/caf\xc3\xa9.txt", url, sizeof(url)) == 1);
    assert_string_equals(url, "file:///tmp/caf%C3%A9.txt");
    assert(build_file_url("/tmp/a\nb", url, sizeof(url)) == 1);
    assert_string_equals(url, "file:///tmp/a%0Ab");

    /* Path characters that must stay literal. */
    assert(build_file_url("/tmp/a-b_c.d~e", url, sizeof(url)) == 1);
    assert_string_equals(url, "file:///tmp/a-b_c.d~e");

    /* A buffer that cannot hold the result fails instead of truncating. */
    assert(build_file_url("/a/very/long/path/that/never/fits", small, sizeof(small)) == 0);
    assert(build_file_url("/x", tiny, sizeof(tiny)) == 0);
    assert(build_file_url("/x", url, 4) == 0);

    /* Null inputs are rejected. */
    assert(build_file_url(NULL, url, sizeof(url)) == 0);
    assert(build_file_url("/x", NULL, sizeof(url)) == 0);
}

/* --- JSON helpers ------------------------------------------------------- */

static void test_json_escape(void) {
    char long_value[8192];
    const char *first;
    const char *second;
    char copy[64];
    size_t escaped_length;

    assert_string_equals(json_escape("plain text"), "plain text");
    assert_string_equals(json_escape("a\"b\\c"), "a\\\"b\\\\c");
    assert_string_equals(json_escape("line\nbreak"), "line\\u000abreak");
    assert_string_equals(json_escape("tab\there"), "tab\\u0009here");
    assert_string_equals(json_escape("caf\xc3\xa9"), "caf\xc3\xa9");

    /* The result lives in one shared buffer: copy it before the next call. */
    first = json_escape("first");
    snprintf(copy, sizeof(copy), "%s", first);
    second = json_escape("second");
    assert_string_equals(copy, "first");
    assert_string_equals(second, "second");

    /* Oversized input stops early and still returns a terminated string. */
    memset(long_value, 'a', sizeof(long_value) - 1);
    long_value[sizeof(long_value) - 1] = '\0';
    escaped_length = strlen(json_escape(long_value));
    assert(escaped_length > 0);
    assert(escaped_length < 4096);
}

static void test_append_json_string(void) {
    GString *output = g_string_new(NULL);

    append_json_string(output, "plain");
    assert_string_equals(output->str, "\"plain\"");

    g_string_truncate(output, 0);
    append_json_string(output, "a\"b\\c\nd\te\x01" "f");
    assert_string_equals(output->str, "\"a\\\"b\\\\c\\nd\\te\\u0001f\"");

    g_string_truncate(output, 0);
    append_json_string(output, "caf\xc3\xa9 \xe2\x9c\x93");
    assert_string_equals(output->str, "\"caf\xc3\xa9 \xe2\x9c\x93\"");

    g_string_truncate(output, 0);
    append_json_string(output, "");
    assert_string_equals(output->str, "\"\"");

    g_string_free(output, TRUE);
}

/* --- shared error replies ----------------------------------------------- */

static void test_return_native_error(void) {
    reset_recordings();

    return_native_error((webview_t)(void *)0x1, "req-7", "NO_FILE", "Bad \"path\"");

    assert(recorded_returns == 1);
    assert_string_equals(recorded_id, "req-7");
    assert(recorded_status == 1); /* status 1 rejects the promise in webview */
    assert_string_equals(
        recorded_result,
        "{\"error\":{\"code\":\"NO_FILE\",\"message\":\"Bad \\\"path\\\"\"}}");

    /* Messages keep their newlines readable as JSON escapes. */
    reset_recordings();
    return_native_error((webview_t)(void *)0x1, "8", "WRITE_FAILED", "line\nnext");
    assert_string_equals(
        recorded_result,
        "{\"error\":{\"code\":\"WRITE_FAILED\",\"message\":\"line\\nnext\"}}");
}

/* --- picker dispatch ---------------------------------------------------- */

static int picker_calls;
static char picker_request_id[128];

/* Stands in for the routine main() would run on the GTK main loop. */
static void fake_picker(webview_t view, void *argument) {
    picker_request *request = argument;

    picker_calls++;
    assert(request != NULL);
    assert(view == request->app->view);
    assert(request->request_id != NULL);
    snprintf(picker_request_id, sizeof(picker_request_id), "%s", request->request_id);
    g_free(request->request_id);
    free(request);
}

static void test_dispatch_picker(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.view = (webview_t)(void *)0x2;
    picker_calls = 0;
    picker_request_id[0] = '\0';
    reset_recordings();

    /* A scheduled picker hands its request to the dispatched callback. */
    assert(dispatch_picker(&app, "picker-1", fake_picker, "folder chooser") == 1);
    assert(recorded_dispatches == 1);
    assert(dispatched_callback == fake_picker);
    assert(dispatched_argument != NULL);
    assert(recorded_returns == 0);

    /* Ownership passes to the main loop, which runs the callback later. */
    {
        picker_request *pending = dispatched_argument;
        assert(pending->app == &app);
        assert(pending->request_id != NULL);
        assert_string_equals(pending->request_id, "picker-1");
        dispatched_callback(app.view, dispatched_argument);
    }
    assert(picker_calls == 1);
    assert_string_equals(picker_request_id, "picker-1");

    /* When dispatch fails the request itself is rejected, exactly once. */
    dispatch_reply = WEBVIEW_ERROR_INVALID_STATE;
    assert(dispatch_picker(&app, "picker-2", fake_picker, "folder chooser") == 0);
    assert(picker_calls == 1); /* the callback never ran */
    assert(recorded_returns == 1);
    assert(recorded_status == 1);
    assert_string_equals(recorded_id, "picker-2");
    assert(string_contains(recorded_result, "DISPATCH_ERROR"));
    assert(string_contains(recorded_result, "The folder chooser could not be opened."));

    /* The native handle request targets the top-level window. */
    assert(webview_get_native_handle(app.view, WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET) == NULL);
    assert(recorded_handle_kind == (int)WEBVIEW_NATIVE_HANDLE_KIND_UI_WIDGET);
}

int main(void) {
    test_build_file_url();
    test_json_escape();
    test_append_json_string();
    test_return_native_error();
    test_dispatch_picker();
    return 0;
}
