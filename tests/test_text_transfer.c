/*
 * Unit tests for text_transfer.c: the saveTextFile argument decoder, the
 * suggested-name sanitizer, and the binding-level validation that decides
 * between dispatching a picker and rejecting the request.
 *
 * The picker callbacks themselves never run here: webview_dispatch is a
 * recording stub, so GTK is linked only because app_support.c (the shared
 * chooser and dispatch plumbing) shares this translation unit.
 */

#include "text_transfer.h"

#include "app_support.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* --- recorded webview stubs -------------------------------------------- */

static int recorded_returns;
static char recorded_id[128];
static int recorded_status;
static char recorded_result[1024];

static int recorded_dispatches;
static void (*dispatched_callback)(webview_t, void *);
static void *dispatched_argument;
static webview_error_t dispatch_reply = WEBVIEW_ERROR_OK;

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
    (void)kind;
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
}

/* Frees a dispatched picker request the callback will never run for. */
static void release_pending_request(void) {
    picker_request *pending = dispatched_argument;
    assert(pending != NULL);
    free(pending->request_id);
    g_free(pending->payload);
    free(pending);
    dispatched_argument = NULL;
    dispatched_callback = NULL;
}

/* --- decode -------------------------------------------------------------- */

static void test_decode_valid_pair(void) {
    char *name = NULL;
    char *content = NULL;

    assert(text_transfer_decode_save_request(
               "[\"outline.json\",\"line one\\nline \\\"two\\\"\"]", &name, &content) ==
           TEXT_TRANSFER_OK);
    assert_string_equals(name, "outline.json");
    assert_string_equals(content, "line one\nline \"two\"");
    free(name);
    free(content);

    /* Backslash escapes, tabs, and unicode code points resolve too. */
    assert(text_transfer_decode_save_request(
               "[\"a\\\\b\",\"tab\\there caf\\u00e9\"]", &name, &content) ==
           TEXT_TRANSFER_OK);
    assert_string_equals(name, "a\\b");
    assert_string_equals(content, "tab\there caf\xc3\xa9");
    free(name);
    free(content);

    /* Surrogate pairs become one UTF-8 sequence. */
    assert(text_transfer_decode_save_request("[\"n\",\"\\ud83d\\ude00\"]", &name, &content) ==
           TEXT_TRANSFER_OK);
    assert_string_equals(content, "\xf0\x9f\x98\x80");
    free(name);
    free(content);

    /* Whitespace between tokens is tolerated; empty content is valid. */
    assert(text_transfer_decode_save_request(" [ \"a\" , \"\" ] ", &name, &content) ==
           TEXT_TRANSFER_OK);
    assert_string_equals(name, "a");
    assert_string_equals(content, "");
    free(name);
    free(content);
}

static void test_decode_rejects_malformed_requests(void) {
    char *name = (char *)0x1;
    char *content = (char *)0x1;

    assert(text_transfer_decode_save_request(NULL, &name, &content) ==
           TEXT_TRANSFER_ERR_NULL);
    assert(name == NULL && content == NULL);

    const char *bad_requests[] = {
        "null",
        "\"just a string\"",
        "{\"name\":\"a\"}",
        "[\"only-one\"]",
        "[1,2]",
        "[\"a\" \"b\"]",
        "[\"a\",\"b\"] trailing",
        "[\"a\", \"unterminated",
        "[\"bad\\xescape\",\"b\"]",
        "[\"a\",\"b\"",
    };
    for (size_t i = 0; i < sizeof(bad_requests) / sizeof(bad_requests[0]); i++) {
        name = (char *)0x1;
        content = (char *)0x1;
        text_transfer_status status =
            text_transfer_decode_save_request(bad_requests[i], &name, &content);
        if (status != TEXT_TRANSFER_ERR_ARGUMENT) {
            fprintf(stderr, "expected ARGUMENT for: %s\n", bad_requests[i]);
            assert(0);
        }
        assert(name == NULL && content == NULL);
    }

    /* NULL outputs are rejected instead of writing through NULL. */
    assert(text_transfer_decode_save_request("[\"a\",\"b\"]", NULL, &content) ==
           TEXT_TRANSFER_ERR_NULL);
    assert(text_transfer_decode_save_request("[\"a\",\"b\"]", &name, NULL) ==
           TEXT_TRANSFER_ERR_NULL);
}

static void test_decode_rejects_oversized_content(void) {
    size_t cap = TEXT_TRANSFER_MAX_BYTES;
    size_t prefix = strlen("[\"n\",\"");
    char *request = malloc(prefix + cap + 4);
    char *name = NULL;
    char *content = NULL;

    assert(request != NULL);
    memcpy(request, "[\"n\",\"", prefix);
    memset(request + prefix, 'a', cap + 1);
    request[prefix + cap + 1] = '"';
    request[prefix + cap + 2] = ']';
    request[prefix + cap + 3] = '\0';

    assert(text_transfer_decode_save_request(request, &name, &content) ==
           TEXT_TRANSFER_ERR_TOO_LARGE);
    assert(name == NULL && content == NULL);
    free(request);
}

/* --- suggested names ----------------------------------------------------- */

static void test_suggest_name(void) {
    char *name;

    /* Plain names pass through; paths lose their directories. */
    name = text_transfer_suggest_name("outline.json", "export.txt");
    assert_string_equals(name, "outline.json");
    free(name);

    name = text_transfer_suggest_name("/home/user/notes.md", "export.txt");
    assert_string_equals(name, "notes.md");
    free(name);

    name = text_transfer_suggest_name("C:\\tmp\\report.txt", "export.txt");
    assert_string_equals(name, "report.txt");
    free(name);

    /* Reserved characters are replaced, leading dots trimmed. */
    name = text_transfer_suggest_name("..\\evil<name>:?.txt", "export.txt");
    assert_string_equals(name, "evil_name___.txt");
    free(name);

    /* Empty, dot-only, and whitespace results fall back. */
    name = text_transfer_suggest_name("", "section.txt");
    assert_string_equals(name, "section.txt");
    free(name);

    name = text_transfer_suggest_name(" . ", "section.txt");
    assert_string_equals(name, "section.txt");
    free(name);

    name = text_transfer_suggest_name(NULL, "section.txt");
    assert_string_equals(name, "section.txt");
    free(name);

    /* Long names cap at 60 bytes. */
    char long_name[128];
    memset(long_name, 'a', 100);
    long_name[100] = '\0';
    name = text_transfer_suggest_name(long_name, "export.txt");
    assert(strlen(name) == 60);
    free(name);

    /* The cap never splits a multi-byte character: "a" + U+00E9 pairs land
     * on a continuation byte at index 60, so the cut walks back to 59. */
    char utf8_name[256];
    utf8_name[0] = 'a';
    for (int i = 0; i < 100; i++) {
        utf8_name[1 + i * 2] = '\xc3';
        utf8_name[2 + i * 2] = '\xa9';
    }
    utf8_name[201] = '\0';
    name = text_transfer_suggest_name(utf8_name, "export.txt");
    assert(strlen(name) == 59);
    for (size_t i = 0; i < strlen(name); i++) {
        unsigned char byte = (unsigned char)name[i];
        if ((byte & 0xC0) == 0x80) {
            unsigned char previous = (unsigned char)name[i - 1];
            assert(previous == 0xC3 || previous == 0xF0);
        }
    }
    free(name);
}

static void test_strerror(void) {
    assert(string_contains(text_transfer_strerror(TEXT_TRANSFER_ERR_NULL), "missing"));
    assert(string_contains(text_transfer_strerror(TEXT_TRANSFER_ERR_ARGUMENT), "malformed"));
    assert(string_contains(text_transfer_strerror(TEXT_TRANSFER_ERR_TOO_LARGE), "8 MiB"));
    assert(string_contains(text_transfer_strerror(TEXT_TRANSFER_ERR_MEMORY), "prepared"));
}

/* --- binding validation --------------------------------------------------- */

static void test_save_binding_validates_before_dispatch(void) {
    app_context app = {0};
    char *name;
    char *content;

    /* Malformed arguments reject immediately without opening a dialog. */
    reset_recordings();
    on_save_text_file("req-bad", "[\"a\"]", &app);
    assert(recorded_returns == 1);
    assert_string_equals(recorded_id, "req-bad");
    assert(recorded_status == 1);
    assert(string_contains(recorded_result, "INVALID_ARGUMENT"));
    assert(recorded_dispatches == 0);

    /* Valid arguments dispatch, and the raw request travels as the payload. */
    reset_recordings();
    on_save_text_file("req-ok", "[\"a.txt\",\"body\"]", &app);
    assert(recorded_returns == 0);
    assert(recorded_dispatches == 1);
    assert(dispatched_callback != NULL);
    assert(text_transfer_decode_save_request(
               ((picker_request *)dispatched_argument)->payload, &name, &content) ==
           TEXT_TRANSFER_OK);
    assert_string_equals(name, "a.txt");
    assert_string_equals(content, "body");
    free(name);
    free(content);
    release_pending_request();

    /* A dispatch failure rejects the request and frees the payload. */
    reset_recordings();
    dispatch_reply = WEBVIEW_ERROR_UNSPECIFIED;
    on_save_text_file("req-fail", "[\"a.txt\",\"body\"]", &app);
    assert(recorded_returns == 1);
    assert(string_contains(recorded_result, "DISPATCH_ERROR"));
}

static void test_open_binding_dispatches(void) {
    app_context app = {0};

    reset_recordings();
    on_open_text_file("req-open", "[]", &app);
    assert(recorded_returns == 0);
    assert(recorded_dispatches == 1);
    assert(dispatched_callback != NULL);
    release_pending_request();
}

int main(void) {
    test_decode_valid_pair();
    test_decode_rejects_malformed_requests();
    test_decode_rejects_oversized_content();
    test_suggest_name();
    test_strerror();
    test_save_binding_validates_before_dispatch();
    test_open_binding_dispatches();
    printf("text_transfer tests passed\n");
    return 0;
}
