/*
 * Unit tests for json_io.c: the host's single JSON writer and request reader.
 *
 * These are the guarantees every binding now relies on, so they are asserted
 * once, here, instead of implicitly in each consumer: the writer escapes
 * without a size limit, and the reader accepts exactly one grammar (escapes
 * decoded, raw control bytes rejected, exact allocations, nothing trailing).
 */

#include "json_io.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void assert_string_equals(const char *actual, const char *expected) {
    if (actual == NULL || strcmp(actual, expected) != 0) {
        fprintf(stderr, "expected \"%s\" but got \"%s\"\n", expected, actual == NULL ? "(null)" : actual);
        abort();
    }
}

/* --- writing -------------------------------------------------------------- */

static void test_append_string(void) {
    GString *output = g_string_new(NULL);

    json_append_string(output, "plain");
    assert_string_equals(output->str, "\"plain\"");

    g_string_truncate(output, 0);
    json_append_string(output, "a\"b\\c\nd\te\x01" "f");
    assert_string_equals(output->str, "\"a\\\"b\\\\c\\nd\\te\\u0001f\"");

    g_string_truncate(output, 0);
    json_append_string(output, "caf\xc3\xa9 \xe2\x9c\x93");
    assert_string_equals(output->str, "\"caf\xc3\xa9 \xe2\x9c\x93\"");

    g_string_truncate(output, 0);
    json_append_string(output, "");
    assert_string_equals(output->str, "\"\"");

    /* The writer has no buffer limit: a long value is never truncated. */
    g_string_truncate(output, 0);
    {
        char *long_value = malloc(9000);
        assert(long_value != NULL);
        memset(long_value, 'a', 8999);
        long_value[8999] = '\0';
        json_append_string(output, long_value);
        assert(output->len == 9001);
        free(long_value);
    }

    g_string_free(output, TRUE);
}

static void test_append_error(void) {
    GString *output = g_string_new(NULL);

    json_append_error(output, "INVALID_ARGUMENT", "The file is not a document.");
    assert_string_equals(output->str,
        "{\"error\":{\"code\":\"INVALID_ARGUMENT\",\"message\":\"The file is not a document.\"}}");

    /* A quote in a message must not break the document. */
    g_string_truncate(output, 0);
    json_append_error(output, "READ_FAILED", "Could not read \"x\".");
    assert_string_equals(output->str,
        "{\"error\":{\"code\":\"READ_FAILED\",\"message\":\"Could not read \\\"x\\\".\"}}");

    g_string_free(output, TRUE);
}

static void test_strerror(void) {
    assert(json_strerror(JSON_OK) != NULL);
    assert(json_strerror(JSON_ERR_MALFORMED) != NULL);
    assert(json_strerror(JSON_ERR_CONTROL) != NULL);
    assert(json_strerror((json_result)-99) != NULL);
}

/* --- reading -------------------------------------------------------------- */

static void test_read_single(void) {
    char *values[1] = {NULL};
    size_t lengths[1] = {0};

    assert(json_read_string_array("[\"plain\"]", 1, values, lengths) == JSON_OK);
    assert_string_equals(values[0], "plain");
    assert(lengths[0] == 5);
    json_free_values(values, 1);
    assert(values[0] == NULL);
}

static void test_read_pair_with_escapes(void) {
    char *values[2] = {NULL, NULL};
    size_t lengths[2] = {0, 0};

    assert(json_read_string_array("[\"a.txt\", \"line\\nbreak \\\"quoted\\\"\"]", 2, values, lengths) == JSON_OK);
    assert_string_equals(values[0], "a.txt");
    assert_string_equals(values[1], "line\nbreak \"quoted\"");
    json_free_values(values, 2);
}

static void test_read_unicode_and_surrogates(void) {
    char *values[1] = {NULL};
    size_t lengths[1] = {0};

    assert(json_read_string_array("[\"caf\\u00e9\"]", 1, values, lengths) == JSON_OK);
    assert_string_equals(values[0], "caf\xc3\xa9");
    json_free_values(values, 1);

    /* A surrogate pair becomes one four-byte code point. */
    assert(json_read_string_array("[\"\\ud83d\\ude00\"]", 1, values, lengths) == JSON_OK);
    assert(lengths[0] == 4);
    assert_string_equals(values[0], "\xf0\x9f\x98\x80");
    json_free_values(values, 1);
}

static void test_read_whitespace_and_empty(void) {
    char *values[2] = {NULL, NULL};

    assert(json_read_string_array("  [\t\"one\"\n , \"\" ]  ", 2, values, NULL) == JSON_OK);
    assert_string_equals(values[0], "one");
    assert_string_equals(values[1], "");
    json_free_values(values, 2);

    assert(json_read_string_array("[\"\"]", 1, values, NULL) == JSON_OK);
    assert_string_equals(values[0], "");
    json_free_values(values, 1);
}

/*
 * The exact allocation the codec promises: a value is sized to its decoded
 * length, so a saveTextFile payload no longer reserves the whole request.
 */
static void test_exact_allocation(void) {
    char *values[2] = {NULL, NULL};
    size_t lengths[2] = {7, 0};

    assert(json_read_string_array("[\"abcdefg\\n\", \"x\"]", 2, values, lengths) == JSON_OK);
    assert(lengths[0] == 8);
    assert(lengths[1] == 1);
    json_free_values(values, 2);
}

static void test_read_rejects_raw_control_bytes(void) {
    char *values[1] = {NULL};

    /* The grammar every binding shares: control bytes must be escaped. */
    assert(json_read_string_array("[\"a\tb\"]", 1, values, NULL) == JSON_ERR_CONTROL);
    assert(json_read_string_array("[\"a\x01" "b\"]", 1, values, NULL) == JSON_ERR_CONTROL);
    assert(json_read_string_array("[\"a\\nb\"]", 1, values, NULL) == JSON_OK);
    json_free_values(values, 1);
}

static void test_read_rejects_malformed(void) {
    static const char *bad[] = {
        NULL,
        "",
        "[]",
        "[\"a\",\"b\"",
        "[\"a\" \"b\"]",
        "[\"a\",]",
        "[\"a\",\"b\"] trailing",
        "[\"a\",\"b\",\"c\"]",
        "[\"a\",2]",
        "[\"a\",\"\\q\"]",
        "[\"a\",\"\\u00zz\"]",
        "[\"a\",\"\\u00e",
        "not json",
    };
    for (size_t index = 0; index < sizeof(bad) / sizeof(bad[0]); index++) {
        char *values[2] = {NULL, NULL};
        assert(json_read_string_array(bad[index], 2, values, NULL) != JSON_OK);
        assert(values[0] == NULL);
        assert(values[1] == NULL);
    }

    assert(json_read_string_array("[\"a\"]", 1, NULL, NULL) == JSON_ERR_NULL);
}

/* A zero-length request is trivially satisfied and must not allocate. */
static void test_read_zero_count(void) {
    char *values[1] = {NULL};
    assert(json_read_string_array("[]", 0, values, NULL) == JSON_OK);
    assert(values[0] == NULL);
    /* A NULL request is a protocol error whatever the expected count is. */
    assert(json_read_string_array(NULL, 0, values, NULL) == JSON_ERR_NULL);
}

int main(void) {
    test_append_string();
    test_append_error();
    test_strerror();

    test_read_single();
    test_read_pair_with_escapes();
    test_read_unicode_and_surrogates();
    test_read_whitespace_and_empty();
    test_exact_allocation();
    test_read_rejects_raw_control_bytes();
    test_read_rejects_malformed();
    test_read_zero_count();

    printf("All JSON codec tests passed\n");
    return 0;
}
