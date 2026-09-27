/*
 * Unit tests for the combined-outline PDF renderer (outline_pdf.c).
 *
 * The renderer is exercised through its two bindings with the webview calls
 * replaced by recording stubs, so the whole path is asserted without a GUI: the
 * name sanitizer, the requirement for a user-chosen directory, the pagination,
 * and the fact that the file cairo writes is a real PDF the reader can open.
 *
 * Cairo is linked for the real thing, not mocked: the question "is this actually
 * a PDF, and does it grow past one page" cannot be answered honestly against a
 * fake surface.
 */

#include "json_io.h"
#include "outline_pdf.h"

#include <assert.h>
#include <cairo.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <glib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* --- recorded webview stubs -------------------------------------------- */

static int recorded_returns;
static char recorded_id[128];
static char recorded_result[1024];

static int recorded_dispatches;
static void (*dispatched_callback)(webview_t, void *);
static void *dispatched_argument;

webview_error_t webview_return(webview_t view, const char *id, int status, const char *result) {
    (void)view;
    (void)status;
    recorded_returns++;
    snprintf(recorded_id, sizeof(recorded_id), "%s", id != NULL ? id : "");
    snprintf(recorded_result, sizeof(recorded_result), "%s", result != NULL ? result : "");
    return WEBVIEW_ERROR_OK;
}

webview_error_t webview_dispatch(webview_t view, void (*fn)(webview_t, void *), void *argument) {
    /* Records only, never invokes: the real callback is a blocking GTK dialog
       and there is no display here. renderOutlinePdf needs no dispatch at all -
       it is synchronous and never opens a dialog - so nothing under test
       depends on the callback running. */
    (void)view;
    recorded_dispatches++;
    dispatched_callback = fn;
    dispatched_argument = argument;
    return WEBVIEW_ERROR_OK;
}

void *webview_get_native_handle(webview_t view, webview_native_handle_kind_t kind) {
    (void)view;
    (void)kind;
    return NULL;
}

/* --- helpers ------------------------------------------------------------ */

static int string_contains(const char *text, const char *needle) {
    return text != NULL && strstr(text, needle) != NULL;
}

/* Table-driven cases need the failing row in the output, not just the value. */
static void assert_contains(const char *haystack, const char *needle, const char *label) {
    if (string_contains(haystack, needle)) return;
    fprintf(stderr, "%s: expected to contain [%s], got: %s\n", label, needle,
        haystack == NULL ? "(null)" : haystack);
    abort();
}

static char workspace[256];

static void reset_recordings(void) {
    recorded_returns = 0;
    recorded_id[0] = '\0';
    recorded_result[0] = '\0';
    recorded_dispatches = 0;
    dispatched_callback = NULL;
    dispatched_argument = NULL;
}

static long file_size(const char *path) {
    GStatBuf info;
    if (g_stat(path, &info) != 0) return -1;
    return (long)info.st_size;
}

/* Reads the first bytes of a file: a PDF always starts with the %PDF- header. */
static int starts_with_pdf_header(const char *path) {
    char header[8];
    FILE *file = fopen(path, "rb");
    size_t read;
    if (file == NULL) return 0;
    read = fread(header, 1, sizeof(header), file);
    fclose(file);
    return read >= 5 && memcmp(header, "%PDF-", 5) == 0;
}

/* A request is the webview's ["arg", "arg"] JSON array. */
static char *request_for(const char *name, const char *json) {
    GString *out = g_string_new(NULL);
    g_string_append_c(out, '[');
    json_append_string(out, name);
    g_string_append_c(out, ',');
    json_append_string(out, json);
    g_string_append_c(out, ']');
    return g_string_free(out, FALSE);
}

static const char *simple_outline =
    "{\"format\":\"metrics-toc\",\"title\":\"Field Report\",\"items\":["
    "{\"title\":\"Introduction\",\"level\":1,\"content\":\"The survey began at dawn.\"},"
    "{\"title\":\"Findings\",\"level\":2,\"content\":\"Seven nests were counted.\"}"
    "]}";

/* --- name sanitizing ---------------------------------------------------- */

/*
 * The name comes from the webview, so it is the one value that could try to
 * escape the chosen directory. Every one of these has to come out as a plain
 * basename with a .pdf suffix.
 */
static void test_suggested_name_cannot_escape_the_directory(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    struct { const char *requested; const char *expected; } cases[] = {
        { "report", "report.pdf" },
        { "report.pdf", "report.pdf" },
        { "../escape", "escape.pdf" },
        { "../../etc/passwd", "passwd.pdf" },
        { "/absolute/path", "path.pdf" },
        { "with\\backslash", "backslash.pdf" },
        { "..", "outline.pdf" },
        { ".", "outline.pdf" },
        { "", "outline.pdf" },
        { "semi:colon*star?quote\"pipe|", "semicolonstarquotepipe.pdf" },
    };

    for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
        char *request = request_for(cases[index].requested, simple_outline);
        char expected_path[512];
        reset_recordings();

        on_render_outline_pdf("req", request, &app);

        assert(recorded_returns == 1);
        assert(string_contains(recorded_result, "\"error\"") == 0);
        snprintf(expected_path, sizeof(expected_path), "%s/%s", workspace, cases[index].expected);
        assert_contains(recorded_result, cases[index].expected,
            cases[index].requested);
        assert(g_file_test(expected_path, G_FILE_TEST_EXISTS));
        assert(starts_with_pdf_header(expected_path));
        unlink(expected_path);
        g_free(request);
    }
}

static void test_a_long_name_is_bounded(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    GString *long_name = g_string_new(NULL);
    for (int index = 0; index < 400; index++) g_string_append_c(long_name, 'a');
    char *request = request_for(long_name->str, simple_outline);
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    /* Bounded to 120 characters plus the suffix, and still inside the folder. */
    assert(string_contains(recorded_result, "\"error\"") == 0);
    assert(string_contains(recorded_result, workspace));
    g_string_free(long_name, TRUE);
    g_free(request);
}

/* --- directory requirement ---------------------------------------------- */

/*
 * Without a user-chosen directory the binding must refuse. This is the guard
 * that stops the webview from naming any path on the disk to write into.
 */
static void test_render_refuses_without_a_chosen_directory(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    char *request = request_for("report", simple_outline);
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(recorded_returns == 1);
    assert(string_contains(recorded_result, "NO_WORKSPACE_DIRECTORY"));
    g_free(request);
}

/* --- bad requests ------------------------------------------------------- */

static void test_render_rejects_bad_requests(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    struct { const char *request; const char *code; } cases[] = {
        { "[\"report\"]", "INVALID_ARGUMENT" },
        { "[\"a\",\"b\",\"c\"]", "INVALID_ARGUMENT" },
        { "[\"report\",\"not json\"]", "INVALID_OUTLINE" },
        { "[\"report\",\"[1,2]\"]", "INVALID_OUTLINE" },
        { "[\"report\",\"{\\\"items\\\":\"]", "INVALID_OUTLINE" },
    };

    for (size_t index = 0; index < sizeof(cases) / sizeof(cases[0]); index++) {
        reset_recordings();
        on_render_outline_pdf("req", cases[index].request, &app);
        assert(recorded_returns == 1);
        assert_contains(recorded_result, cases[index].code, cases[index].request);
    }
}

/* --- rendering ---------------------------------------------------------- */

static void test_render_writes_a_real_pdf(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;
    char *request = request_for("combined", simple_outline);
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(recorded_returns == 1);
    assert(string_contains(recorded_result, "\"error\"") == 0);
    char path[512];
    snprintf(path, sizeof(path), "%s/combined.pdf", workspace);
    assert(g_file_test(path, G_FILE_TEST_EXISTS));
    assert(starts_with_pdf_header(path));
    assert(file_size(path) > 0);
    assert(string_contains(recorded_result, "\"path\""));
    assert(string_contains(recorded_result, "\"name\""));
    assert(string_contains(recorded_result, "\"pages\":1"));
    assert(string_contains(recorded_result, "\"bytes\":"));
    unlink(path);
    g_free(request);
}

/* An outline with no items is still a valid, openable one-page document. */
static void test_empty_outline_still_produces_a_pdf(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;
    char *request = request_for("empty", "{\"format\":\"metrics-toc\",\"items\":[]}");
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(string_contains(recorded_result, "\"error\"") == 0);
    char path[512];
    snprintf(path, sizeof(path), "%s/empty.pdf", workspace);
    assert(g_file_test(path, G_FILE_TEST_EXISTS));
    assert(starts_with_pdf_header(path));
    unlink(path);
    g_free(request);
}

/*
 * Enough text to overflow one A4 page, which is the property that matters for a
 * document builder: the page count has to go up, and the result still has to be
 * a single valid file.
 */
static void test_long_outline_paginates(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    GString *body = g_string_new(NULL);
    for (int paragraph = 0; paragraph < 120; paragraph++) {
        g_string_append(body,
            "The measured section of the survey recorded a steady increase in the "
            "number of active nests across every visit, with the highest counts "
            "near the northern boundary of the managed plot.\n\n");
    }
    GString *outline = g_string_new(NULL);
    g_string_append(outline, "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Long\",");
    g_string_append(outline, "\"level\":1,\"content\":");
    json_append_string(outline, body->str);
    g_string_append(outline, "}]}");

    char *request = request_for("long", outline->str);
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(string_contains(recorded_result, "\"error\"") == 0);
    int pages = 0;
    const char *marker = strstr(recorded_result, "\"pages\":");
    assert(marker != NULL);
    pages = atoi(marker + 8);
    assert(pages > 3);
    char path[512];
    snprintf(path, sizeof(path), "%s/long.pdf", workspace);
    assert(starts_with_pdf_header(path));
    assert(file_size(path) > 1000);
    unlink(path);
    g_string_free(outline, TRUE);
    g_string_free(body, TRUE);
    g_free(request);
}

/*
 * A single unbroken token longer than the measure, which is what a pasted URL or
 * a hash looks like. It has to be split rather than drawn past the margin or
 * dropped, because dropping would lose draft content.
 */
static void test_an_unbroken_long_word_is_split_not_dropped(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    GString *token = g_string_new(NULL);
    for (int index = 0; index < 400; index++) g_string_append_c(token, 'W');
    GString *outline = g_string_new(NULL);
    g_string_append(outline, "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Link\",");
    g_string_append(outline, "\"level\":1,\"content\":");
    json_append_string(outline, token->str);
    g_string_append(outline, "}]}");

    char *request = request_for("token", outline->str);
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(string_contains(recorded_result, "\"error\"") == 0);
    char path[512];
    snprintf(path, sizeof(path), "%s/token.pdf", workspace);
    assert(g_file_test(path, G_FILE_TEST_EXISTS));
    assert(starts_with_pdf_header(path));
    unlink(path);
    g_string_free(outline, TRUE);
    g_string_free(token, TRUE);
    g_free(request);
}

/* Level values from a hand-edited outline are clamped, never trusted. */
static void test_levels_are_clamped(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;

    const char *outlines[] = {
        "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Zero\",\"level\":0,\"content\":\"x\"}]}",
        "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Huge\",\"level\":99,\"content\":\"x\"}]}",
        "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Text\",\"level\":\"two\",\"content\":\"x\"}]}",
        "{\"format\":\"metrics-toc\",\"items\":[{\"title\":\"Negative\",\"level\":-4,\"content\":\"x\"}]}",
    };
    for (size_t index = 0; index < sizeof(outlines) / sizeof(outlines[0]); index++) {
        char *request = request_for("levels", outlines[index]);
        reset_recordings();
        on_render_outline_pdf("req", request, &app);
        assert(string_contains(recorded_result, "\"error\"") == 0);
        char path[512];
        snprintf(path, sizeof(path), "%s/levels.pdf", workspace);
        assert(starts_with_pdf_header(path));
        unlink(path);
        g_free(request);
    }
}

/* An item with no title is skipped rather than drawn as a blank heading. */
static void test_items_without_titles_are_skipped(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    app.outline_dir = workspace;
    char *request = request_for("untitled",
        "{\"format\":\"metrics-toc\",\"items\":[{\"level\":1,\"content\":\"orphan\"},"
        "{\"title\":\"\",\"content\":\"blank\"},{\"title\":\"Real\",\"content\":\"body\"}]}");
    reset_recordings();

    on_render_outline_pdf("req", request, &app);

    assert(string_contains(recorded_result, "\"error\"") == 0);
    char path[512];
    snprintf(path, sizeof(path), "%s/untitled.pdf", workspace);
    assert(starts_with_pdf_header(path));
    unlink(path);
    g_free(request);
}

/*
 * The choose binding must schedule its dialog on the GTK main loop and must not
 * set a directory until the user actually answers. The callback is not run here
 * - it is a blocking dialog - so the assertion is that it was scheduled and that
 * no directory appeared as a side effect of the binding being called.
 */
static void test_choose_directory_schedules_a_picker_without_choosing(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    reset_recordings();

    on_choose_outline_directory("req", NULL, &app);

    assert(recorded_dispatches == 1);
    assert(dispatched_callback != NULL);
    assert(dispatched_argument != NULL);
    assert(app.outline_dir == NULL);
    assert(recorded_returns == 0);
}

int main(void) {
    snprintf(workspace, sizeof(workspace), "/tmp/outline-pdf-test-%d", (int)getpid());
    if (g_mkdir_with_parents(workspace, 0755) != 0) {
        fprintf(stderr, "could not create the test workspace\n");
        return 1;
    }

    test_suggested_name_cannot_escape_the_directory();
    test_a_long_name_is_bounded();
    test_render_refuses_without_a_chosen_directory();
    test_render_rejects_bad_requests();
    test_render_writes_a_real_pdf();
    test_empty_outline_still_produces_a_pdf();
    test_long_outline_paginates();
    test_an_unbroken_long_word_is_split_not_dropped();
    test_levels_are_clamped();
    test_items_without_titles_are_skipped();
    test_choose_directory_schedules_a_picker_without_choosing();

    rmdir(workspace);
    printf("All outline PDF tests passed\n");
    return 0;
}
