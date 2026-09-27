/*
 * Unit tests for pdf_toc.c: heading extraction from real fixture PDFs, the
 * per-document cache round trip, and the JSON reply the TOC Manager receives.
 *
 * Extraction spawns pdftotext for real, so the tests need it on PATH (the
 * Makefile checks). Fixtures are generated into build/pdf-toc-test and the
 * XDG data directory is redirected there so the cache never touches the real
 * user home. json_io.c is linked only for json_append_string(), which needs
 * no webview, so this suite runs with no GUI and no stub header.
 */

#include "pdf_toc.h"

#include "json_io.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TEST_DIRECTORY "build/pdf-toc-test"
#define CACHE_SUBDIRECTORY "native-workspace/pdf-toc"

static void assert_string_equals(const char *actual, const char *expected) {
    assert(actual != NULL);
    if (strcmp(actual, expected) != 0) {
        fprintf(stderr, "expected: %s\nactual:   %s\n", expected, actual);
        assert(0);
    }
}

/* Appends one PDF object, remembering its file offset for the xref table. */
static void append_object(GString *pdf, GArray *offsets, const char *body) {
    size_t number = offsets->len + 1;
    gsize offset = pdf->len;

    g_array_append_val(offsets, offset);
    g_string_append_printf(pdf, "%zu 0 obj\n%s\nendobj\n", number, body);
}

/*
 * Writes a one-page Helvetica PDF: an optional 24 pt heading line followed by
 * two 12 pt body lines. That size gap is what the TSV pass keys on.
 */
static void write_fixture_pdf(const char *path, const char *heading) {
    GString *stream = g_string_new("BT\n");
    GString *pdf = g_string_new("%PDF-1.4\n");
    GArray *offsets = g_array_new(FALSE, FALSE, sizeof(gsize));
    char *contents;

    if (heading != NULL) {
        g_string_append_printf(stream, "/F1 24 Tf 72 740 Td (%s) Tj -72 -740 Td\n", heading);
    }
    g_string_append(stream, "/F1 12 Tf 72 700 Td (This is the body paragraph text used for median.) Tj -72 -700 Td\n");
    g_string_append(stream, "/F1 12 Tf 72 684 Td (Body line two of the paragraph stays small.) Tj -72 -684 Td\n");
    g_string_append(stream, "ET\n");

    append_object(pdf, offsets, "<< /Type /Catalog /Pages 2 0 R >>");
    append_object(pdf, offsets, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    append_object(pdf, offsets, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                                "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
    contents = g_strdup_printf("<< /Length %zu >>\nstream\n%sendstream", stream->len, stream->str);
    append_object(pdf, offsets, contents);
    g_free(contents);
    append_object(pdf, offsets, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
                                "/Encoding /WinAnsiEncoding >>");

    gsize xref_offset = pdf->len;

    g_string_append_printf(pdf, "xref\n0 %zu\n", (size_t)(offsets->len + 1));
    g_string_append(pdf, "0000000000 65535 f \n");
    for (gsize index = 0; index < offsets->len; index++) {
        g_string_append_printf(pdf, "%010" G_GSIZE_FORMAT " 00000 n \n", g_array_index(offsets, gsize, index));
    }
    g_string_append_printf(pdf, "trailer\n<< /Size %zu /Root 1 0 R >>\nstartxref\n%zu\n%%%%EOF\n",
        (size_t)(offsets->len + 1), xref_offset);

    assert(g_file_set_contents(path, pdf->str, pdf->len, NULL) == TRUE);

    g_array_free(offsets, TRUE);
    g_string_free(pdf, TRUE);
    g_string_free(stream, TRUE);
}

/* Builds a toc on the heap; pdf_toc_clear() releases it. */
static pdf_toc make_toc(const pdf_heading *entries, size_t count) {
    pdf_toc toc = {0};

    if (count > 0) {
        toc.items = calloc(count, sizeof(*toc.items));
        assert(toc.items != NULL);
        for (size_t index = 0; index < count; index++) {
            toc.items[index].page = entries[index].page;
            toc.items[index].level = entries[index].level;
            toc.items[index].position = entries[index].position;
            toc.items[index].title = g_strdup(entries[index].title);
        }
        toc.count = count;
    }
    return toc;
}

/* --- heading extraction ------------------------------------------------- */

static void test_extract_pdf_toc(void) {
    char *heading_pdf = g_build_filename(TEST_DIRECTORY, "with-heading.pdf", NULL);
    char *plain_pdf = g_build_filename(TEST_DIRECTORY, "plain.pdf", NULL);
    char *missing_pdf = g_build_filename(TEST_DIRECTORY, "missing.pdf", NULL);
    pdf_toc toc = {0};
    GError *error = NULL;

    write_fixture_pdf(heading_pdf, "Chapter 1 Introduction");
    write_fixture_pdf(plain_pdf, NULL);

    assert(extract_pdf_toc(heading_pdf, &toc, &error) == 1);
    assert(error == NULL);
    assert(toc.count == 1);
    assert(toc.items[0].page == 1);
    assert(toc.items[0].level == 1);
    assert(toc.items[0].position > 0.0);
    assert_string_equals(toc.items[0].title, "Chapter 1 Introduction");
    pdf_toc_clear(&toc);

    /* Clearing twice must stay safe for callers that retry. */
    pdf_toc_clear(&toc);
    assert(toc.items == NULL);
    assert(toc.count == 0);

    /* A PDF without headings reports why instead of returning an empty list. */
    assert(extract_pdf_toc(plain_pdf, &toc, &error) == 0);
    assert(error != NULL);
    assert(strstr(error->message, "No headings could be extracted") != NULL);
    g_clear_error(&error);
    assert(toc.count == 0);

    /* A path that does not exist fails the same user-facing way. */
    assert(extract_pdf_toc(missing_pdf, &toc, &error) == 0);
    assert(error != NULL);
    assert(strstr(error->message, "No headings could be extracted") != NULL);
    g_clear_error(&error);

    g_free(heading_pdf);
    g_free(plain_pdf);
    g_free(missing_pdf);
}

/* --- per-document cache ------------------------------------------------- */

static void test_cache_round_trip(void) {
    const pdf_heading entries[] = {
        { 1, 1, 12.5, "Chapter 1 Introduction" },
        { 3, 2, 11.0, "Methods \"quoted\" caf\xc3\xa9" },
    };
    pdf_toc original = make_toc(entries, 2);
    pdf_toc restored = {0};
    pdf_toc stale = {0};
    pdf_toc_request request = { .path = NULL, .fingerprint = (char *)"fp-1", .cache_path = NULL };
    pdf_toc_request changed;
    pdf_toc_request missing;
    pdf_toc_request corrupt;
    char *cache_path = toc_cache_path("document-1");
    char *cache_directory = NULL;
    char *corrupt_path = g_build_filename(TEST_DIRECTORY, "corrupt.cache", NULL);

    /* The cache lives under the redirected XDG data directory. */
    assert(strstr(cache_path, CACHE_SUBDIRECTORY "/document-1") != NULL);
    cache_directory = g_path_get_dirname(cache_path);
    assert(g_file_test(cache_directory, G_FILE_TEST_IS_DIR));
    g_free(cache_directory);
    request.cache_path = cache_path;

    write_cached_toc(&request, &original);
    assert(g_file_test(cache_path, G_FILE_TEST_IS_REGULAR));
    assert(read_cached_toc(&request, &restored) == 1);
    assert(restored.count == 2);
    assert(restored.items[0].page == 1);
    assert(restored.items[0].level == 1);
    assert(restored.items[0].position > 12.49 && restored.items[0].position < 12.51);
    assert_string_equals(restored.items[0].title, "Chapter 1 Introduction");
    assert(restored.items[1].page == 3);
    assert(restored.items[1].level == 2);
    assert_string_equals(restored.items[1].title, "Methods \"quoted\" caf\xc3\xa9");
    pdf_toc_clear(&restored);

    /* A changed fingerprint never reuses the stale entries. */
    changed = request;
    changed.fingerprint = (char *)"fp-2";
    assert(read_cached_toc(&changed, &stale) == 0);
    assert(stale.count == 0);

    /* A cache that was never written reads as a miss. */
    missing = request;
    missing.cache_path = (char *)"/nonexistent/native-workspace-cache";
    assert(read_cached_toc(&missing, &stale) == 0);
    assert(stale.count == 0);

    /* A cache with the wrong format marker is ignored as a whole. */
    assert(g_file_set_contents(corrupt_path,
        "wrong-format-marker\nfp-1\nH\t1\t12.50\t1\taGVsbG8=\n", -1, NULL) == TRUE);
    corrupt = request;
    corrupt.cache_path = corrupt_path;
    assert(read_cached_toc(&corrupt, &stale) == 0);
    assert(stale.count == 0);

    pdf_toc_clear(&stale);
    pdf_toc_clear(&original);
    g_free(corrupt_path);
    g_free(cache_path);
}

/* --- JSON reply --------------------------------------------------------- */

static void test_build_toc_response(void) {
    const pdf_heading entries[] = { { 2, 3, 4.5, "Quoted \"title\" and \\path\ncafé" } };
    pdf_toc toc = make_toc(entries, 1);
    pdf_toc empty = {0};
    pdf_toc_request request = { .path = NULL, .fingerprint = (char *)"fp-9", .cache_path = NULL };
    char *json = build_toc_response(&request, &toc, 1);

    assert_string_equals(json,
        "{\"documentId\":\"fp-9\",\"cached\":true,\"headings\":["
        "{\"page\":2,\"level\":3,\"position\":4.50,"
        "\"title\":\"Quoted \\\"title\\\" and \\\\path\\ncaf\xc3\xa9\"}]}");
    g_free(json);

    /* An empty extraction still answers with a well-formed shell. */
    json = build_toc_response(&request, &empty, 0);
    assert_string_equals(json, "{\"documentId\":\"fp-9\",\"cached\":false,\"headings\":[]}");
    g_free(json);

    pdf_toc_clear(&toc);
}

/*
 * The title cap is a character cap, not a byte cap: a 180-character Cyrillic
 * or CJK heading must survive, which it did not when the extractor compared
 * GString.len (bytes) against 180.
 */
static void test_title_cap_counts_characters(void) {
    char ascii_title[256];
    char wide_title[3 * 180 + 1];
    size_t index;

    for (index = 0; index + 1 < sizeof(ascii_title) && index < 180; index++) ascii_title[index] = 'a';
    ascii_title[index] = '\0';
    assert(pdf_toc_count_characters(ascii_title) == 180);

    /* 180 three-byte characters: 540 bytes, still 180 characters. */
    for (index = 0; index + 3 < sizeof(wide_title); index += 3) {
        memcpy(wide_title + index, "\xe6\x97\xa5", 3);
    }
    memcpy(wide_title + index, "\0", 1);
    assert(strlen(wide_title) == 540);
    assert(pdf_toc_count_characters(wide_title) == 180);
    assert(pdf_toc_count_characters(wide_title) <= 180);
}

int main(void) {
    test_title_cap_counts_characters();
    /* Redirect the cache root to an absolute path before glib reads it. */
    char *current = g_get_current_dir();
    char *data_home = g_build_filename(current, TEST_DIRECTORY, NULL);

    assert(g_setenv("XDG_DATA_HOME", data_home, TRUE) == TRUE);
    assert(g_mkdir_with_parents(data_home, 0700) == 0);
    g_free(data_home);
    g_free(current);
    assert(g_mkdir_with_parents(TEST_DIRECTORY, 0700) == 0);

    test_extract_pdf_toc();
    test_cache_round_trip();
    test_build_toc_response();
    return 0;
}
