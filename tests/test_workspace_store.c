#include "workspace_store.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>

#define TEST_DIRECTORY "build/workspace-store-test"
#define TEST_PATH TEST_DIRECTORY "/workspace.json"

static void remove_test_file(void) {
    remove(TEST_PATH);
    remove(TEST_PATH ".tmp");
}

static char *load_into(size_t *length_out, workspace_store_result *result_out) {
    return workspace_store_load(TEST_PATH, length_out, result_out);
}

static void assert_string_equals(const char *actual, const char *expected) {
    assert(actual != NULL);
    assert(strcmp(actual, expected) == 0);
}

int main(void) {
    workspace_store_result result = WORKSPACE_STORE_OK;
    size_t length = 0;
    char *loaded;
    char *decoded;
    char *oversized;

    assert(strcmp(workspace_store_strerror(WORKSPACE_STORE_OK), "ok") == 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_NULL)) > 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_TOO_LARGE)) > 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_READ)) > 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_WRITE)) > 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_ARGUMENT)) > 0);
    assert(strlen(workspace_store_strerror(WORKSPACE_STORE_ERR_OUT_OF_MEMORY)) > 0);

    if (mkdir(TEST_DIRECTORY, 0700) != 0) {
        /* The directory already exists when tests rerun. */
        struct stat info;
        assert(stat(TEST_DIRECTORY, &info) == 0);
        assert(S_ISDIR(info.st_mode));
    }
    remove_test_file();

    /* A missing file reports "no state yet", not an error. */
    loaded = load_into(&length, &result);
    assert(result == WORKSPACE_STORE_OK);
    assert(loaded != NULL);
    assert(length == 0);
    assert(loaded[0] == '\0');
    free(loaded);

    /* Round trip preserves UTF-8, escapes, and newlines. */
    {
        const char payload[] =
            "{\"view\":\"editor\",\"note\":\"line\\nbreak \\\"quoted\\\" caf\xc3\xa9 \xe2\x9c\x93\"}";
        size_t payload_length = sizeof(payload) - 1;

        result = workspace_store_save(TEST_PATH, payload, payload_length);
        assert(result == WORKSPACE_STORE_OK);

        loaded = load_into(&length, &result);
        assert(result == WORKSPACE_STORE_OK);
        assert(length == payload_length);
        assert_string_equals(loaded, payload);
        assert(workspace_store_is_object(loaded, length) == 1);
        free(loaded);
    }

    /* A second save replaces the previous contents atomically. */
    {
        const char replacement[] = "{\"view\":\"menu\",\"tocItems\":[]}";
        result = workspace_store_save(TEST_PATH, replacement, sizeof(replacement) - 1);
        assert(result == WORKSPACE_STORE_OK);
        loaded = load_into(&length, &result);
        assert(result == WORKSPACE_STORE_OK);
        assert_string_equals(loaded, replacement);
        free(loaded);
    }

    /* Size and NULL guards. */
    oversized = malloc(WORKSPACE_STORE_MAX_BYTES + 1);
    assert(oversized != NULL);
    memset(oversized, 'a', WORKSPACE_STORE_MAX_BYTES + 1);
    assert(workspace_store_save(TEST_PATH, oversized, WORKSPACE_STORE_MAX_BYTES + 1) ==
           WORKSPACE_STORE_ERR_TOO_LARGE);
    free(oversized);
    assert(workspace_store_save(NULL, "{}", 2) == WORKSPACE_STORE_ERR_NULL);
    assert(workspace_store_save(TEST_PATH, NULL, 2) == WORKSPACE_STORE_ERR_NULL);

    /* JSON object detection. */
    assert(workspace_store_is_object("{ }", 3) == 1);
    assert(workspace_store_is_object("  {\n\"a\":1}\n ", 12) == 1);
    assert(workspace_store_is_object("[]", 2) == 0);
    assert(workspace_store_is_object("", 0) == 0);
    assert(workspace_store_is_object(NULL, 0) == 0);
    assert(workspace_store_is_object("{}", 1) == 0);

    /* Argument decoding: plain string. */
    decoded = workspace_store_decode_argument("[\"{\\\"view\\\":\\\"menu\\\"}\"]", &result);
    assert(result == WORKSPACE_STORE_OK);
    assert_string_equals(decoded, "{\"view\":\"menu\"}");
    free(decoded);

    /* Whitespace and nested braces survive. */
    decoded = workspace_store_decode_argument("  [ \"a]b}c\" ]  ", &result);
    assert(result == WORKSPACE_STORE_OK);
    assert_string_equals(decoded, "a]b}c");
    free(decoded);

    /* Escape sequences: quote, backslash, slash, control characters. */
    decoded = workspace_store_decode_argument("[\"\\\"\\\\\\/\\b\\f\\n\\r\\t\"]", &result);
    assert(result == WORKSPACE_STORE_OK);
    assert_string_equals(decoded, "\"\\/\b\f\n\r\t");
    free(decoded);

    /* Unicode escapes, including a surrogate pair. */
    decoded = workspace_store_decode_argument("[\"caf\\u00e9\"]", &result);
    assert(result == WORKSPACE_STORE_OK);
    assert_string_equals(decoded, "caf\xc3\xa9");
    free(decoded);

    decoded = workspace_store_decode_argument("[\"\\ud83d\\ude00\"]", &result);
    assert(result == WORKSPACE_STORE_OK);
    assert_string_equals(decoded, "\xf0\x9f\x98\x80");
    free(decoded);

    /* Malformed argument lists are rejected. */
    assert(workspace_store_decode_argument(NULL, &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_NULL);
    assert(workspace_store_decode_argument("", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[]", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[42]", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[\"unterminated]", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[\"bad\\u12\"]", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[\"ok\"] trailing", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);
    assert(workspace_store_decode_argument("[\"broken\\q\"]", &result) == NULL);
    assert(result == WORKSPACE_STORE_ERR_ARGUMENT);

    /* A NULL result pointer is tolerated. */
    decoded = workspace_store_decode_argument("[\"value\"]", NULL);
    assert_string_equals(decoded, "value");
    free(decoded);

    remove_test_file();
    return 0;
}
