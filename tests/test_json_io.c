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

/* --- reading general JSON -------------------------------------------------- */

static void test_parse_scalars(void) {
    json_result status = JSON_ERR_MALFORMED;
    json_value *root = json_parse("null", &status);
    assert(root != NULL && root->type == JSON_VALUE_NULL && status == JSON_OK);
    json_value_free(root);

    root = json_parse("true", &status);
    assert(json_bool(root, 0) == 1);
    json_value_free(root);

    root = json_parse("false", &status);
    assert(json_bool(root, 1) == 0);
    json_value_free(root);

    root = json_parse("42", &status);
    assert(json_number(root, -1) == 42.0);
    json_value_free(root);

    root = json_parse("-1.5e2", &status);
    assert(json_number(root, 0) == -150.0);
    json_value_free(root);
}

static void test_parse_object_and_lookups(void) {
    json_result status = JSON_ERR_MALFORMED;
    json_value *root = json_parse(
        "{\"format\":\"metrics-toc\",\"version\":1,\"items\":[{\"title\":\"One\"}]}",
        &status);
    assert(root != NULL && root->type == JSON_VALUE_OBJECT && status == JSON_OK);
    assert_string_equals(json_string(json_object_get(root, "format"), NULL), "metrics-toc");
    assert(json_number(json_object_get(root, "version"), 0) == 1.0);
    assert(json_object_get(root, "absent") == NULL);
    assert_string_equals(json_string(json_object_get(root, "absent"), "fallback"), "fallback");
    assert(json_count(json_object_get(root, "items")) == 1);
    json_value_free(root);
}

static void test_parse_nested_arrays(void) {
    json_result status = JSON_ERR_MALFORMED;
    json_value *root = json_parse("[[1,2],[3]]", &status);
    assert(root != NULL && root->type == JSON_VALUE_ARRAY);
    assert(json_count(root) == 2);
    assert(json_count(json_at(root, 0)) == 2);
    assert(json_number(json_at(json_at(root, 0), 1), 0) == 2.0);
    assert(json_count(json_at(root, 1)) == 1);
    assert(json_at(root, 9) == NULL); /* out of range is NULL, not a fault */
    json_value_free(root);
}

static void test_parse_strings_decode_escapes(void) {
    json_result status = JSON_ERR_MALFORMED;
    json_value *root = json_parse("\"a\\nb\\u00e9\\ud83d\\ude00\"", &status);
    assert(root != NULL && status == JSON_OK);
    assert_string_equals(json_string(root, NULL), "a\nb\xc3\xa9\xf0\x9f\x98\x80");
    json_value_free(root);
}

static void test_parse_whitespace_and_empty_containers(void) {
    json_result status = JSON_ERR_MALFORMED;
    json_value *root = json_parse("  {\n \"a\" : [ ] ,\n \"b\" : { } \n}  ", &status);
    assert(root != NULL && status == JSON_OK);
    assert(json_count(json_object_get(root, "a")) == 0);
    assert(json_count(json_object_get(root, "b")) == 0);
    json_value_free(root);
}

static void test_parse_rejects_malformed(void) {
    json_result status = JSON_OK;
    const char *bad[] = {
        "",          /* empty */
        "{",         /* unterminated */
        "[1,]",      /* trailing comma */
        "{\"a\":}",  /* missing value */
        "{a:1}",     /* unquoted key */
        "tru",       /* truncated literal */
        "1 2",       /* trailing content */
        "{} {}",     /* two documents */
        "\"unterminated",
        "1.",        /* JSON needs a digit after the point */
        "1e",        /* and after the exponent */
    };
    for (size_t index = 0; index < sizeof(bad) / sizeof(bad[0]); index++) {
        json_value *root = json_parse(bad[index], &status);
        assert(root == NULL);
        assert(status != JSON_OK);
    }
    assert(json_parse(NULL, &status) == NULL);
    assert(status == JSON_ERR_NULL);
}

/*
 * The depth bound is a security property, not a style choice: this parser is
 * recursive, and the input arrives straight from a webview call.
 */
static void test_parse_bounds_nesting_depth(void) {
    json_result status = JSON_OK;
    GString *deep = g_string_new(NULL);
    for (int index = 0; index < JSON_MAX_DEPTH + 10; index++) g_string_append_c(deep, '[');
    for (int index = 0; index < JSON_MAX_DEPTH + 10; index++) g_string_append_c(deep, ']');

    assert(json_parse(deep->str, &status) == NULL); /* over-deep nesting is refused */
    assert(status != JSON_OK);
    g_string_free(deep, TRUE);

    /* Just inside the bound still parses, so the limit is not off by one. */
    GString *shallow = g_string_new(NULL);
    for (int index = 0; index < JSON_MAX_DEPTH; index++) g_string_append_c(shallow, '[');
    for (int index = 0; index < JSON_MAX_DEPTH; index++) g_string_append_c(shallow, ']');
    json_value *root = json_parse(shallow->str, &status);
    assert(root != NULL && status == JSON_OK);
    json_value_free(root);
    g_string_free(shallow, TRUE);
}

static void test_accessors_tolerate_wrong_types(void) {
    json_result status = JSON_OK;
    json_value *root = json_parse("{\"n\":5,\"s\":\"x\",\"a\":[1]}", &status);
    const json_value *number = json_object_get(root, "n");
    const json_value *text = json_object_get(root, "s");
    const json_value *array = json_object_get(root, "a");

    /* Every accessor answers with its fallback instead of faulting. */
    assert_string_equals(json_string(number, "fallback"), "fallback");
    assert(json_number(text, -1) == -1.0);
    assert(json_bool(number, 9) == 9);
    assert(json_count(text) == 0); /* a string is not a container */
    assert(json_count(NULL) == 0);
    assert(json_at(text, 0) == NULL);
    assert(json_string(NULL, "d") != NULL && strcmp(json_string(NULL, "d"), "d") == 0);
    assert(json_number(NULL, 7) == 7.0);
    assert(json_object_get(root, NULL) == NULL);
    assert(json_object_get(text, "n") == NULL); /* a string is not an object */
    assert(json_number(json_at(array, 0), 0) == 1.0);
    json_value_free(root);
    json_value_free(NULL);
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

    test_parse_scalars();
    test_parse_object_and_lookups();
    test_parse_nested_arrays();
    test_parse_strings_decode_escapes();
    test_parse_whitespace_and_empty_containers();
    test_parse_rejects_malformed();
    test_parse_bounds_nesting_depth();
    test_accessors_tolerate_wrong_types();

    printf("All JSON codec tests passed\n");
    return 0;
}
