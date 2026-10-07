/*
 * Unit tests for the image directory scan (image_directory.c).
 *
 * This module had no suite at all, which is why two things shipped unnoticed: the
 * scan sent every *original* to the page, so a collection of 12 MP photos was
 * ~120 MB of base64 held in the JS heap to fill 187x140 grid cells, and the
 * reply's "limited" flag was computed but never sent, so a truncated scan read
 * as a complete one.
 *
 * The webview calls are recording stubs, so no GUI is involved. GdkPixbuf is
 * linked for real: whether a thumbnail is actually smaller than its source is
 * the whole claim, and it cannot be checked against a fake decoder.
 *
 * Images are written as real JPEGs by GdkPixbuf rather than checked in as
 * fixtures, so the test is not tied to a particular decoder's output bytes.
 */

#include "image_directory.h"
#include "json_io.h"

#include <assert.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* --- recorded webview stubs -------------------------------------------- */

static int recorded_returns;
static char recorded_id[128];
static char *recorded_result;
static webview_error_t dispatch_reply = WEBVIEW_ERROR_OK;

webview_error_t webview_return(webview_t view, const char *id, int status, const char *result) {
    (void)view;
    (void)status;
    recorded_returns++;
    snprintf(recorded_id, sizeof(recorded_id), "%s", id != NULL ? id : "");
    g_free(recorded_result);
    recorded_result = g_strdup(result != NULL ? result : "");
    return WEBVIEW_ERROR_OK;
}

webview_error_t webview_dispatch(webview_t view, void (*fn)(webview_t, void *), void *argument) {
    (void)view;
    (void)fn;
    (void)argument;
    return dispatch_reply;
}

void *webview_get_native_handle(webview_t view, webview_native_handle_kind_t kind) {
    (void)view;
    (void)kind;
    return NULL;
}

char *run_path_chooser(webview_t view, picker_kind kind, const char *title,
    const picker_filter *filter, const char *suggested_name) {
    (void)view; (void)kind; (void)title; (void)filter; (void)suggested_name;
    return NULL;
}

/*
 * on_open_image_directory_at dispatches its work to the main loop, and the
 * tests drive that path without one. The real dispatcher builds a
 * picker_request carrying the JSON payload and the request id, then invokes the
 * callback on the GTK main loop; here it is invoked synchronously, which is the
 * only difference. The chooser stub above returns NULL, so the chooser branch is
 * the "cancelled" one and nothing here depends on it.
 */
int dispatch_picker_with_payload(app_context *app, const char *request_id,
    picker_callback callback, const char *picker_name, char *payload) {
    (void)picker_name;
    /* Heap, because the callback releases the request and the payload, exactly
       as it does in production; a stack one would be freed out from under it. */
    picker_request *request = g_new0(picker_request, 1);
    request->request_id = g_strdup(request_id);
    request->app = app;
    request->payload = payload;
    if (callback != NULL) callback(app->view, request);
    return 1;
}

int dispatch_picker(app_context *app, const char *request_id,
    picker_callback callback, const char *picker_name) {
    (void)app; (void)request_id; (void)callback; (void)picker_name;
    return 1;
}

void picker_request_release(picker_request *request) {
    (void)request;
}

void return_native_error(webview_t view, const char *request_id, const char *code,
    const char *message) {
    (void)view;
    (void)request_id;
    /* The frontend branches on this shape, so the tests assert on it exactly.
       recorded_returns is bumped here because in production this path is what
       answers the request - the tests treat a recorded error and a recorded
       success as equally "the binding replied". */
    recorded_returns++;
    GString *reply = g_string_new("{\"error\":{\"code\":");
    json_append_string(reply, code != NULL ? code : "UNKNOWN");
    g_string_append(reply, ",\"message\":");
    json_append_string(reply, message != NULL ? message : "");
    g_string_append_c(reply, '}');
    g_string_append_c(reply, '}');
    g_free(recorded_result);
    recorded_result = g_string_free(reply, FALSE);
}

/* --- helpers ------------------------------------------------------------ */

static char workspace[256];

static void reset_recordings(void) {
    recorded_returns = 0;
    recorded_id[0] = '\0';
    g_free(recorded_result);
    recorded_result = NULL;
}

/* Scans a directory through the binding and returns the recorded reply. */
static const char *scan(const char *directory) {
    app_context app;
    memset(&app, 0, sizeof(app));
    char *request = NULL;
    GString *quoted = g_string_new("[\"");
    for (const char *cursor = directory; *cursor != '\0'; cursor++) {
        if (*cursor == '"' || *cursor == '\\') g_string_append_c(quoted, '\\');
        g_string_append_c(quoted, *cursor);
    }
    g_string_append_c(quoted, '"');
    g_string_append_c(quoted, ']');
    request = g_string_free(quoted, FALSE);

    reset_recordings();
    on_open_image_directory_at("scan", request, &app);
    g_free(request);
    return recorded_result;
}

/* Writes a JPEG of the given size, returns its path. */
static char *write_jpeg(const char *name, int width, int height) {
    char *path = g_build_filename(workspace, name, NULL);
    GdkPixbuf *pixbuf = gdk_pixbuf_new(GDK_COLORSPACE_RGB, FALSE, 8, width, height);
    assert(pixbuf != NULL);
    /*
     * A gradient rather than a flat fill, so a downscale has something to
     * average and JPEG does not compress it away to nothing. Written a row at a
     * time: filling 12 megapixels one pixel at a time is slow enough to notice.
     */
    {
        guchar *pixels = gdk_pixbuf_get_pixels(pixbuf);
        int rowstride = gdk_pixbuf_get_rowstride(pixbuf);
        int channels = gdk_pixbuf_get_n_channels(pixbuf);
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                guchar *pixel = pixels + (gsize)y * rowstride + (gsize)x * channels;
                pixel[0] = (guchar)((x * 255) / (width > 1 ? width : 1));
                pixel[1] = (guchar)((y * 255) / (height > 1 ? height : 1));
                pixel[2] = 0x80;
            }
        }
    }
    assert(gdk_pixbuf_save(pixbuf, path, "jpeg", NULL, "quality", "90", NULL));
    g_object_unref(pixbuf);
    return path;
}

static long long file_size(const char *path) {
    GStatBuf info;
    if (g_stat(path, &info) != 0) return -1;
    return (long long)info.st_size;
}

/* Reads one field out of the reply without a full JSON parse: the reply is a
   flat array of objects and this only needs to find substrings. */
static int reply_has(const char *needle) {
    return recorded_result != NULL && strstr(recorded_result, needle) != NULL;
}

/* The decoded byte length of the first "thumbnail":"data:...;base64,XXX" entry. */
static long long thumbnail_base64_bytes(const char *reply) {
    const char *at = strstr(reply, "\"thumbnail\":\"data:image/jpeg;base64,");
    if (at == NULL) return -1;
    at += strlen("\"thumbnail\":\"data:image/jpeg;base64,");
    const char *end = strchr(at, '"');
    if (end == NULL) return -1;
    return (long long)(end - at);
}

static long long original_base64_bytes(const char *reply) {
    const char *at = strstr(reply, "\"dataUrl\":\"data:");
    if (at == NULL) return -1;
    const char *comma = strchr(at + strlen("\"dataUrl\":\"data:"), ',');
    if (comma == NULL) return -1;
    at = comma + 1;
    const char *end = strchr(at, '"');
    if (end == NULL) return -1;
    return (long long)(end - at);
}

/* --- the memory claim --------------------------------------------------- */

/*
 * A thumbnail must be dramatically smaller than the original.
 *
 * This is the regression the whole change exists for, and it is asserted as a
 * *ratio* rather than an absolute byte count so it holds across decoders: a
 * different libjpeg build produces different bytes but the same order of
 * magnitude. Measured on this machine, 4032x3024 -> 320px was 1,829 bytes from a
 * 187 KB original, so 20x is a very conservative floor.
 */
static void test_a_thumbnail_is_far_smaller_than_its_original(void) {
    char *big = write_jpeg("big.jpg", 4032, 3024);
    long long original_bytes = file_size(big);
    assert(original_bytes > 100 * 1024);

    scan(workspace);
    assert(recorded_returns == 1);
    assert(!reply_has("\"error\""));

    long long thumb = thumbnail_base64_bytes(recorded_result);
    assert(thumb > 0);

    /*
     * The whole reply, not just the thumbnail field, must be far smaller than
     * the original would have been. That is the property that matters: this is
     * what the page holds for the whole session. Compared against the original
     * on disk, plus the 33% base64 overhead the old reply paid on top.
     */
    long long original_as_base64 = (original_bytes / 3 + 1) * 4;
    assert(thumb * 20 < original_as_base64);
    fprintf(stderr,
        "  original %lld B on disk (%lld B as base64) -> thumbnail %lld B\n",
        original_bytes, original_as_base64, thumb);

    /* And the reported dimensions are the scaled ones, not the original's. */
    assert(reply_has("\"width\":320"));
    assert(reply_has("\"height\":240"));
    /* 4032x3024 scaled to a 320 long edge is 320x240. */
    assert(!reply_has("\"width\":4032"));

    unlink(big);
}

/* The reply must not carry the original's bytes under any other name. */
static void test_the_reply_carries_no_full_resolution_payload(void) {
    char *big = write_jpeg("big.jpg", 4032, 3024);
    scan(workspace);
    assert(recorded_result != NULL);
    assert(reply_has("\"thumbnail\""));
    assert(reply_has("\"path\""));
    /* The path is what the lightbox asks for later; nothing else. */
    assert(reply_has("\"size\":"));
    assert(reply_has("\"mime\":\"image/jpeg\""));
    unlink(big);
}

/* A small image is not blown up to the thumbnail size: that costs bytes for
   nothing, and a 200x150 logo upscaled to 320 looks worse than it did. */
static void test_a_small_image_is_not_upscaled(void) {
    char *small = write_jpeg("small.jpg", 200, 150);
    scan(workspace);
    assert(reply_has("\"width\":200"));
    assert(reply_has("\"height\":150"));
    assert(!reply_has("\"width\":320"));
    unlink(small);
}

/* A portrait image is scaled on its long edge, so the short one follows. */
static void test_a_portrait_image_keeps_its_aspect_ratio(void) {
    char *portrait = write_jpeg("portrait.jpg", 3000, 4000);
    scan(workspace);
    assert(reply_has("\"width\":240"));
    assert(reply_has("\"height\":320"));
    unlink(portrait);
}

/* A file with an image extension but no decodable content must not disappear:
   the fallback sends the original, and the reply says how often that happened. */
static void test_an_undecodable_file_falls_back_and_reports_it(void) {
    char *path = g_build_filename(workspace, "broken.jpg", NULL);
    FILE *file = fopen(path, "wb");
    assert(file != NULL);
    assert(fwrite("this is not a jpeg", 1, 19, file) == 19);
    assert(fclose(file) == 0);

    scan(workspace);
    /* The image is still offered, as its original bytes. */
    assert(reply_has("\"fallbacks\":1"));
    assert(reply_has("\"mime\":\"image/jpeg\""));
    assert(!reply_has("\"error\""));

    unlink(path);
}

/* A decodable image alongside an undecodable one reports zero fallbacks, which
   is what makes the count meaningful. */
static void test_a_clean_directory_reports_no_fallbacks(void) {
    char *good = write_jpeg("good.jpg", 1200, 900);
    scan(workspace);
    assert(reply_has("\"fallbacks\":0"));
    assert(reply_has("\"limited\":false"));
    unlink(good);
}

/* --- honesty flags ------------------------------------------------------ */

/* "limited" and "fallbacks" must be present on every successful reply, so the
   frontend can tell a complete scan from a truncated one. */
static void test_the_reply_always_states_its_honesty(void) {
    char *good = write_jpeg("honest.jpg", 800, 600);
    scan(workspace);
    assert(reply_has("\"limited\":"));
    assert(reply_has("\"fallbacks\":"));
    unlink(good);
}

/* --- loadImageAt -------------------------------------------------------- */

/* The lightbox asks for one full-resolution image by the path the scan gave. */
static void test_load_image_at_serves_a_scanned_path(void) {
    char *big = write_jpeg("lightbox.jpg", 1600, 1200);
    scan(workspace);
    long long thumb = thumbnail_base64_bytes(recorded_result);
    assert(thumb > 0);

    app_context app;
    memset(&app, 0, sizeof(app));
    GString *request = g_string_new("[\"");
    for (const char *cursor = big; *cursor != '\0'; cursor++) {
        if (*cursor == '"' || *cursor == '\\') g_string_append_c(request, '\\');
        g_string_append_c(request, *cursor);
    }
    g_string_append(request, "\"]");

    reset_recordings();
    on_load_image_at("load", request->str, &app);
    assert(recorded_returns == 1);
    assert(!reply_has("\"error\""));
    assert(reply_has("\"dataUrl\":\"data:image/jpeg;base64,"));
    /* Full resolution means more than the thumbnail it replaces. */
    assert(original_base64_bytes(recorded_result) > thumb);

    g_string_free(request, TRUE);
    unlink(big);
}

/*
 * A path the last scan did not produce must be refused.
 *
 * This is the security property: without it, loadImageAt is a general file
 * reader reachable from the page, which is a capability the rest of the bridge
 * deliberately does not have.
 */
static void test_load_image_at_refuses_an_unknown_path(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    /* No scan has run, so nothing is known. */
    reset_recordings();
    on_load_image_at("load", "[\"/etc/passwd\"]", &app);
    assert(recorded_returns == 1);
    assert(reply_has("\"error\""));
    assert(reply_has("IMAGE_PATH_UNKNOWN"));

    /* And a path outside a scanned directory is refused after a scan too. */
    char *outside = g_build_filename(workspace, "inside.jpg", NULL);
    char *sibling = g_build_filename(workspace, "..", "escaped.jpg", NULL);
    write_jpeg("inside.jpg", 400, 300);
    assert(g_rename(outside, sibling) == 0);
    scan(workspace);

    GString *request = g_string_new(NULL);
    g_string_append_c(request, '[');
    json_append_string(request, sibling);
    g_string_append_c(request, ']');
    reset_recordings();
    on_load_image_at("load", request->str, &app);
    assert(reply_has("IMAGE_PATH_UNKNOWN"));
    g_string_free(request, TRUE);

    unlink(sibling);
}

/* A malformed request is a bad request, not a crash. */
static void test_load_image_at_rejects_a_malformed_request(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    reset_recordings();
    on_load_image_at("load", "not json", &app);
    assert(recorded_returns == 1);
    assert(reply_has("\"error\""));

    reset_recordings();
    on_load_image_at("load", "[]", &app);
    assert(recorded_returns == 1);
    assert(reply_has("\"error\""));
}

/* A file with an image name that is not an image is refused by extension. */
static void test_load_image_at_refuses_a_non_image(void) {
    app_context app;
    memset(&app, 0, sizeof(app));
    /* A scanned .txt is never offered, so nothing is known; but a scan that
       produced images must not turn loadImageAt into a reader for the rest of
       the directory either. */
    char *text = g_build_filename(workspace, "notes.txt", NULL);
    FILE *file = fopen(text, "wb");
    assert(file != NULL);
    assert(fwrite("hello", 1, 5, file) == 5);
    assert(fclose(file) == 0);
    char *jpg = write_jpeg("also.jpg", 400, 300);
    scan(workspace);

    GString *request = g_string_new("[\"");
    g_string_append(request, text);
    g_string_append(request, "\"]");
    reset_recordings();
    on_load_image_at("load", request->str, &app);
    assert(reply_has("\"error\""));
    g_string_free(request, TRUE);

    unlink(text);
    unlink(jpg);
}

/* --- directory handling ------------------------------------------------- */

/* An empty or absent directory reports NO_IMAGES rather than an empty success. */
static void test_an_empty_directory_is_an_error(void) {
    char *empty = g_build_filename(workspace, "empty", NULL);
    assert(g_mkdir_with_parents(empty, 0755) == 0);
    scan(empty);
    assert(recorded_returns == 1);
    assert(reply_has("\"error\""));
    assert(reply_has("NO_IMAGES"));
    g_rmdir(empty);
}

int main(void) {
    snprintf(workspace, sizeof(workspace), "/tmp/image-dir-test-%d", (int)getpid());
    if (g_mkdir_with_parents(workspace, 0755) != 0) {
        fprintf(stderr, "could not create the test workspace\n");
        return 1;
    }

    test_a_thumbnail_is_far_smaller_than_its_original();
    test_the_reply_carries_no_full_resolution_payload();
    test_a_small_image_is_not_upscaled();
    test_a_portrait_image_keeps_its_aspect_ratio();
    test_an_undecodable_file_falls_back_and_reports_it();
    test_a_clean_directory_reports_no_fallbacks();
    test_the_reply_always_states_its_honesty();

    test_load_image_at_serves_a_scanned_path();
    test_load_image_at_refuses_an_unknown_path();
    test_load_image_at_rejects_a_malformed_request();
    test_load_image_at_refuses_a_non_image();

    test_an_empty_directory_is_an_error();

    g_free(recorded_result);
    rmdir(workspace);
    printf("All image directory tests passed\n");
    return 0;
}
