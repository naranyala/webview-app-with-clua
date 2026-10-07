/*
 * Unit tests for the durable store: round-trip load/save, the size cap,
 * atomic replace, is_object validation, and argument decoding.
 *
 * Every case writes TEST_FILE in the current directory and removes it, so the
 * suite is safe to run from the Makefile in any order.
 *
 * One assertion is a source check rather than a behavioural one, and its header
 * says why: the read-before-check ordering cannot be observed at runtime on this
 * filesystem. That is a deliberate, weaker claim, not an oversight.
 */

#include "workspace_store.h"

#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

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

/*
 * The size cap must be decided from g_stat, before g_file_get_contents runs.
 *
 * A source assertion, and the reason is in the caller's comment above: on this
 * filesystem neither runtime probe for the ordering discriminates. What this
 * does catch is the real defect -- a pre-check that is deleted, or moved below
 * the read -- which is how this bug was introduced and how it would come back.
 */
static void assert_the_cap_is_checked_before_the_read(void) {
    FILE *source = fopen("src/workspace_store.c", "r");
    assert(source != NULL);

    char text[65536];
    size_t read = fread(text, 1, sizeof(text) - 1, source);
    fclose(source);
    assert(read > 0);
    text[read] = '\0';

    const char *stat_call = strstr(text, "g_stat(path");
    const char *read_call = strstr(text, "g_file_get_contents(path");
    assert(stat_call != NULL);
    assert(read_call != NULL);
    assert(stat_call < read_call);

    /* And the stat must be compared against the cap, not merely present. */
    const char *window = text + (stat_call - text);
    assert(strstr(window, "WORKSPACE_STORE_MAX_BYTES") != NULL);
    assert(strstr(window, "WORKSPACE_STORE_MAX_BYTES") <
           read_call);
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

    /* Size cap boundary: exactly WORKSPACE_STORE_MAX_BYTES is accepted. */
    oversized = malloc(WORKSPACE_STORE_MAX_BYTES);
    assert(oversized != NULL);
    memset(oversized, 'a', WORKSPACE_STORE_MAX_BYTES);
    assert(workspace_store_save(TEST_PATH, oversized, WORKSPACE_STORE_MAX_BYTES) ==
           WORKSPACE_STORE_OK);
    loaded = load_into(&length, &result);
    assert(result == WORKSPACE_STORE_OK);
    assert(length == WORKSPACE_STORE_MAX_BYTES);
    free(loaded);

    /* A file one byte over the cap is refused before its contents are read. */
    {
        FILE *file = fopen(TEST_PATH, "wb");
        assert(file != NULL);
        assert(fwrite(oversized, 1, WORKSPACE_STORE_MAX_BYTES, file) == WORKSPACE_STORE_MAX_BYTES);
        assert(fputc('a', file) != EOF);
        assert(fclose(file) == 0);
        loaded = load_into(&length, &result);
        assert(result == WORKSPACE_STORE_ERR_TOO_LARGE);
        assert(loaded == NULL);
        assert(length == 0);
    }
    free(oversized);
    remove_test_file();

    /*
     * The rejection has to be decided from the file's metadata, before its bytes
     * are read.
     *
     * The assertion above only proves the outcome, which a post-read size check
     * also produces - so on its own it cannot tell the two implementations
     * apart, and the post-read version allocates the whole file first. That runs
     * on the GTK main thread inside the loadWorkspace binding, so a
     * multi-gigabyte workspace.json is a UI stall proportional to a file the user
     * never meant to open.
     *
     * Two runtime probes for the *ordering* were tried and both failed to
     * discriminate, which is why this is a source assertion instead:
     *
     *   - chmod 000, so a read fails and only a stat can succeed. This tree is a
     *     fuseblk mount that does not honour chmod for the owner: measured, the
     *     file stays readable, so the probe passes either way.
     *   - a sparse file (ftruncate past the cap, no blocks written). The read
     *     still succeeds - it returns zeros - so the post-read check rejects it
     *     too, and again both implementations agree.
     *
     * So the ordering is asserted on the source: the size test must appear
     * before the call that allocates. That is a weaker claim than a runtime
     * measurement, and deliberately so - a comment that says "read the file
     * first" must not be able to pass for a working pre-check. It fails on the
     * real defect (a missing or reordered pre-check) rather than on an
     * environmental quirk.
     */
    remove_test_file();

    /* Writing into a directory that does not exist fails instead of pretending. */
    assert(workspace_store_save(TEST_DIRECTORY "/absent/workspace.json", "{}", 2) ==
           WORKSPACE_STORE_ERR_WRITE);

    /* A directory is not a workspace file: reading it reports a read error. */
    loaded = workspace_store_load(TEST_DIRECTORY, &length, &result);
    assert(loaded == NULL);
    assert(result == WORKSPACE_STORE_ERR_READ);
    assert(length == 0);

    remove_test_file();

    assert_the_cap_is_checked_before_the_read();

    return 0;
}
