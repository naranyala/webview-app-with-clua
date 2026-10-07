/*
 * Folder chooser and bounded recursive scan for the Image Viewer.
 *
 * See include/image_directory.h for the layer contract.
 */

#include "image_directory.h"

#include "json_io.h"

#include <gdk-pixbuf/gdk-pixbuf.h>
#include <gio/gio.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Scan budgets: a runaway tree must never stall the GTK main loop. */
#define IMAGE_SCAN_MAX_DEPTH 8
#define IMAGE_SCAN_MAX_FILES 500
#define IMAGE_SCAN_MAX_FILE_SIZE (16LL * 1024LL * 1024LL)
#define IMAGE_SCAN_MAX_TOTAL_SIZE (96LL * 1024LL * 1024LL)

/*
 * The byte budget above counts *original* file sizes, because that is what
 * bounds the work the scan does. It is not the memory the page ends up holding:
 * base64 costs 33% over the raw bytes, so 96 MB of photos becomes ~128 MB of
 * strings. The grid is the reason the originals are not sent at all - see
 * include/image_directory.h.
 */
#define IMAGE_THUMBNAIL_MAX_EDGE 320
#define IMAGE_THUMBNAIL_QUALITY "82"

/* Accumulator for one scan: the JSON array under construction plus totals. */
typedef struct {
    GString *json;
    size_t count;
    long long total_size;
    int limited;
    /* Images whose original had to be sent because no thumbnail could be
       produced. Non-zero means part of the collection is still full-resolution,
       which is exactly the case worth surfacing. */
    size_t fallbacks;
} image_scan_result;

/*
 * Absolute paths of the images the last scan offered, so loadImageAt can serve
 * a full-resolution image without becoming a general file reader. Cleared at the
 * start of every scan, so it can only ever name files this process just walked.
 */
static GSList *known_image_paths = NULL;

static void forget_known_image_paths(void) {
    g_slist_free_full(known_image_paths, g_free);
    known_image_paths = NULL;
}

static void remember_image_path(const char *path) {
    /* The scan offers at most IMAGE_SCAN_MAX_FILES, so the list is bounded. */
    known_image_paths = g_slist_prepend(known_image_paths, g_strdup(path));
}

static int image_path_was_scanned(const char *path) {
    for (GSList *node = known_image_paths; node != NULL; node = node->next) {
        if (g_strcmp0((const char *)node->data, path) == 0) return 1;
    }
    return 0;
}

/* Supported extensions and the MIME type used in the data URL (NULL = skip). */
static const char *image_mime_type(const char *name) {
    static const struct { const char *extension; const char *mime; } types[] = {
        { ".avif", "image/avif" }, { ".bmp", "image/bmp" }, { ".gif", "image/gif" },
        { ".heic", "image/heic" }, { ".heif", "image/heif" }, { ".ico", "image/x-icon" },
        { ".jpeg", "image/jpeg" }, { ".jpg", "image/jpeg" }, { ".png", "image/png" },
        { ".svg", "image/svg+xml" }, { ".tif", "image/tiff" }, { ".tiff", "image/tiff" },
        { ".webp", "image/webp" },
    };
    char *lowercase_name = g_ascii_strdown(name, -1);
    const char *mime = NULL;

    for (size_t index = 0; index < G_N_ELEMENTS(types); index++) {
        if (g_str_has_suffix(lowercase_name, types[index].extension)) {
            mime = types[index].mime;
            break;
        }
    }
    g_free(lowercase_name);
    if (mime != NULL) return mime;
    return NULL;
}

/*
 * Decodes an image, scales it so its longest edge is IMAGE_THUMBNAIL_MAX_EDGE,
 * and returns a JPEG data URL. Returns NULL if the file cannot be decoded or
 * re-encoded, which is the caller's cue to fall back to the original.
 *
 * The scaled dimensions are reported through `width_out`/`height_out` so the
 * frontend can reserve the right box before the bytes arrive, instead of
 * laying out against a 0-height image and reflowing when the data URL decodes.
 *
 * Uses GdkPixbuf rather than reading the bytes here: it is already linked
 * transitively by GTK, it handles every format the MIME table above accepts,
 * and it is the only way to get a real decode without hand-writing a JPEG
 * decoder. The cost is one full-size decode at a time (46 MB of RGBA for a 12 MP
 * photo), which is freed before the next file is read - the point is that the
 * *page* never holds 491 of them, not that decoding is free.
 *
 * Aspect ratio is preserved and the scale is never upscaled: a 200x150 image
 * stays 200x150 rather than being blown up to 320, which would cost bytes and
 * add nothing.
 */
static char *build_thumbnail_data_url(const char *path, int *width_out, int *height_out) {
    GError *error = NULL;
    GdkPixbuf *source = gdk_pixbuf_new_from_file(path, &error);
    if (source == NULL) {
        g_clear_error(&error);
        return NULL;
    }

    int width = gdk_pixbuf_get_width(source);
    int height = gdk_pixbuf_get_height(source);
    int longest = MAX(width, height);

    GdkPixbuf *thumb = NULL;
    if (longest > IMAGE_THUMBNAIL_MAX_EDGE) {
        int target_width = width >= height
            ? IMAGE_THUMBNAIL_MAX_EDGE
            : MAX(1, (int)((long long)width * IMAGE_THUMBNAIL_MAX_EDGE / height));
        int target_height = width >= height
            ? MAX(1, (int)((long long)height * IMAGE_THUMBNAIL_MAX_EDGE / width))
            : IMAGE_THUMBNAIL_MAX_EDGE;
        /* GDK_INTERP_BILINEAR: at this size the difference from GOOD is not
           visible in a 140px-tall grid cell, and it is the cheaper pass. */
        thumb = gdk_pixbuf_scale_simple(source, target_width, target_height, GDK_INTERP_BILINEAR);
    } else {
        /* Already small enough: re-encode as-is so the reply is uniform. */
        thumb = g_object_ref(source);
    }
    g_object_unref(source);
    if (thumb == NULL) return NULL;

    /*
     * Flattened onto white first. A JPEG with alpha gets an error out of the
     * encoder, and a PNG with transparency would otherwise encode its
     * transparent pixels as black, which reads as a broken thumbnail in the
     * grid rather than as transparency.
     */
    GdkPixbuf *flat = gdk_pixbuf_add_alpha(thumb, FALSE, 0xff, 0xff, 0xff);
    g_object_unref(thumb);
    if (flat == NULL) return NULL;

    char *encoded = NULL;
    gsize encoded_length = 0;
    if (!gdk_pixbuf_save_to_buffer(flat, &encoded, &encoded_length, "jpeg", &error,
            "quality", IMAGE_THUMBNAIL_QUALITY, NULL)) {
        g_clear_error(&error);
        g_object_unref(flat);
        return NULL;
    }
    if (width_out != NULL) *width_out = gdk_pixbuf_get_width(flat);
    if (height_out != NULL) *height_out = gdk_pixbuf_get_height(flat);
    g_object_unref(flat);

    GString *url = g_string_new("data:image/jpeg;base64,");
    char *base64 = g_base64_encode((const guchar *)encoded, encoded_length);
    g_free(encoded);
    if (base64 == NULL) {
        g_string_free(url, TRUE);
        return NULL;
    }
    g_string_append(url, base64);
    g_free(base64);
    return g_string_free(url, FALSE);
}

/*
 * Reads a file and returns its data URL, used as the fallback when a thumbnail
 * cannot be produced and for the lightbox's full-resolution request.
 */
static char *build_original_data_url(const char *path, const char *mime, long long size) {
    char *contents = NULL;
    gsize length = 0;
    if (!g_file_get_contents(path, &contents, &length, NULL)) return NULL;
    if (length == 0 || (long long)length != size) {
        g_free(contents);
        return NULL;
    }
    char *encoded = g_base64_encode((const guchar *)contents, length);
    g_free(contents);
    if (encoded == NULL) return NULL;
    GString *url = g_string_new(NULL);
    g_string_append_printf(url, "data:%s;base64,%s", mime, encoded);
    g_free(encoded);
    return g_string_free(url, FALSE);
}

/*
 * Depth-first walk that appends one entry per accepted image: a thumbnail data
 * URL for the grid, the absolute path, and the original's size and MIME type.
 * Symlinks are not followed, and the depth/count/byte budgets set "limited"
 * instead of failing the whole directory.
 */
static void scan_image_directory(const char *directory, const char *relative, int depth, image_scan_result *result) {
    GDir *dir = g_dir_open(directory, 0, NULL);
    if (dir == NULL) return;
    const char *entry;
    while ((entry = g_dir_read_name(dir)) != NULL) {
        char *path = g_build_filename(directory, entry, NULL);
        char *relative_path = relative[0] == '\0' ? g_strdup(entry) : g_strdup_printf("%s/%s", relative, entry);
        GFile *file = g_file_new_for_path(path);
        GFileInfo *info = g_file_query_info(file, G_FILE_ATTRIBUTE_STANDARD_TYPE "," G_FILE_ATTRIBUTE_STANDARD_SIZE,
            G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS, NULL, NULL);
        GFileType type = info == NULL ? G_FILE_TYPE_UNKNOWN : g_file_info_get_file_type(info);
        if (type == G_FILE_TYPE_DIRECTORY) {
            if (depth < IMAGE_SCAN_MAX_DEPTH) scan_image_directory(path, relative_path, depth + 1, result);
        } else if (type == G_FILE_TYPE_REGULAR) {
            const char *mime = image_mime_type(entry);
            long long size = g_file_info_get_size(info);
            if (mime == NULL || size <= 0 || size > IMAGE_SCAN_MAX_FILE_SIZE) {
                g_free(relative_path);
                g_free(path);
                g_clear_object(&info);
                g_object_unref(file);
                continue;
            }
            if (result->count >= IMAGE_SCAN_MAX_FILES || result->total_size + size > IMAGE_SCAN_MAX_TOTAL_SIZE) {
                result->limited = 1;
                g_free(relative_path);
                g_free(path);
                g_clear_object(&info);
                g_object_unref(file);
                continue;
            }
            /*
             * The thumbnail is what the page holds. If it cannot be produced -
             * a format GdkPixbuf has no loader for, a truncated file, a decode
             * that fails for want of memory - the original is sent instead, so
             * the image still appears in the grid. That costs the memory this
             * change is about, so it is worth knowing how often it happens:
             * `fallbacks` counts it and the reply says so.
             */
            int thumb_width = 0;
            int thumb_height = 0;
            char *thumb_url = build_thumbnail_data_url(path, &thumb_width, &thumb_height);
            int fell_back = 0;
            char *mime_out = NULL;
            if (thumb_url != NULL) {
                mime_out = g_strdup("image/jpeg");
            } else {
                thumb_url = build_original_data_url(path, mime, size);
                mime_out = g_strdup(mime);
                /* The original's own dimensions, which the thumbnail could not
                   report because nothing decoded it. */
                thumb_width = 0;
                thumb_height = 0;
                if (thumb_url != NULL) fell_back = 1;
            }

            if (thumb_url != NULL) {
                if (result->count > 0) g_string_append_c(result->json, ',');
                g_string_append(result->json, "{\"name\":");
                json_append_string(result->json, entry);
                g_string_append(result->json, ",\"relativePath\":");
                json_append_string(result->json, relative_path);
                /*
                 * `path` is the absolute path, which is what the lightbox asks
                 * for later. It is the same path the scan just read, so this
                 * discloses nothing the user did not hand us by choosing the
                 * folder, and loadImageAt only serves paths from this walk.
                 */
                g_string_append(result->json, ",\"path\":");
                json_append_string(result->json, path);
                g_string_append(result->json, ",\"mime\":");
                json_append_string(result->json, mime_out);
                g_string_append(result->json, ",\"thumbnail\":");
                json_append_string(result->json, thumb_url);
                g_string_append_printf(result->json, ",\"width\":%d,\"height\":%d", thumb_width, thumb_height);
                g_string_append_printf(result->json, ",\"size\":%lld}", size);
                remember_image_path(path);
                result->count++;
                result->total_size += size;
                if (fell_back) result->fallbacks++;
            }
            g_free(mime_out);
            g_free(thumb_url);
        }
        g_clear_object(&info);
        g_object_unref(file);
        g_free(relative_path);
        g_free(path);
        if (result->count >= IMAGE_SCAN_MAX_FILES || result->total_size >= IMAGE_SCAN_MAX_TOTAL_SIZE) {
            result->limited = 1;
            break;
        }
    }
    g_dir_close(dir);
}

/*
 * Scans a chosen directory and answers with
 * {"images":[...],"name":...,"path":...,"limited":...} or NO_IMAGES. Shared by
 * the chooser and the path-binding so both entry points enforce the same scan
 * budgets and report the same errors.
 *
 * path is borrowed; every failure is reported here rather than returned.
 */
static void answer_image_directory(webview_t view, const char *request_id, const char *path) {
    image_scan_result scan = { .json = g_string_new("{\"images\":[") };
    char *directory_name = NULL;

    /* A new scan replaces the previous one's path list, so loadImageAt can only
       ever serve files this walk just read. */
    forget_known_image_paths();

    scan_image_directory(path, "", 0, &scan);
    directory_name = g_path_get_basename(path);
    g_string_append_c(scan.json, ']');
    g_string_append(scan.json, ",\"name\":");
    json_append_string(scan.json, directory_name);
    /*
     * "path" is what the webview records in its recent-directories history, so
     * a remembered entry can be re-scanned without the chooser.
     */
    g_string_append(scan.json, ",\"path\":");
    json_append_string(scan.json, path);
    /*
     * "limited" and "fallbacks" are both honesty flags, and both are easy to
     * leave out: a scan that stopped at the count or byte budget otherwise reads
     * as a complete one, and a collection where the thumbnails failed looks
     * identical to one where they did not. The second matters because it is the
     * case that puts the memory back.
     */
    g_string_append_printf(scan.json, ",\"limited\":%s", scan.limited ? "true" : "false");
    g_string_append_printf(scan.json, ",\"fallbacks\":%zu}", scan.fallbacks);
    if (scan.count == 0) {
        return_native_error(view, request_id, "NO_IMAGES",
            "No supported images were found within the directory limits.");
    } else {
        webview_return(view, request_id, 0, scan.json->str);
    }
    g_free(directory_name);
    g_string_free(scan.json, TRUE);
}

/*
 * Runs on the GTK main loop after dispatch_picker(): pick a folder, then hand
 * the choice to the shared answer path.
 */
static void show_image_directory_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected_path = run_path_chooser(view, PICKER_SELECT_FOLDER, "Choose Image Directory", NULL, NULL);

    if (selected_path == NULL) {
        webview_return(view, request->request_id, 0, "{\"canceled\":true}");
    } else {
        answer_image_directory(view, request->request_id, selected_path);
    }
    g_free(selected_path);
    picker_request_release(request);
}

/*
 * Runs on the GTK main loop after dispatch_picker_with_payload(): scan the
 * directory the webview named, with no chooser. The path is decoded through the
 * shared JSON codec, so it is validated exactly like any other binding payload,
 * and must be absolute - a relative path would silently resolve against the
 * host's working directory. A path that is not a directory scans to nothing and
 * is reported as NO_IMAGES, the same as an empty folder.
 */
static void open_image_directory_at_path(webview_t view, void *argument) {
    picker_request *request = argument;
    char *values[1] = { NULL };
    json_result decoded = request->payload == NULL
        ? JSON_ERR_NULL
        : json_read_string_array(request->payload, 1, values, NULL);

    if (decoded != JSON_OK) {
        return_native_error(view, request->request_id, "INVALID_PATH",
            "The directory path could not be read.");
    } else if (!g_path_is_absolute(values[0])) {
        return_native_error(view, request->request_id, "INVALID_PATH",
            "The directory path must be absolute.");
    } else {
        answer_image_directory(view, request->request_id, values[0]);
    }
    json_free_values(values, 1);
    picker_request_release(request);
}

void on_open_image_directory(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    dispatch_picker(app, id, show_image_directory_picker, "image directory picker");
}

void on_open_image_directory_at(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char *payload = NULL;

    if (request == NULL) {
        return_native_error(app->view, id, "INVALID_PATH",
            "The directory path could not be read.");
        return;
    }
    payload = g_strdup(request);
    if (payload == NULL) {
        return_native_error(app->view, id, "INTERNAL_ERROR",
            "The directory request could not be prepared.");
        return;
    }
    dispatch_picker_with_payload(app, id, open_image_directory_at_path, "image directory request", payload);
}

/* --- loadImageAt: one full-resolution image, for the lightbox -------------- */

/*
 * The lightbox is the only place that shows an image at more than a thumbnail's
 * worth of pixels, so this is the only caller that needs the original bytes.
 * It holds one image at a time, so this is one decode rather than a collection.
 *
 * The path check is the point of this binding. Without it, `loadImageAt` would
 * be a general file reader reachable from the page: any path the webview cared
 * to name would come back base64-encoded. Requiring the path to be one the last
 * scan walked keeps the capability the user already granted by choosing a
 * folder, and keeps it scoped to images.
 */
void on_load_image_at(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char *values[1] = { NULL };
    json_result decoded = json_read_string_array(request, 1, values, NULL);
    if (decoded != JSON_OK || values[0] == NULL || values[0][0] == '\0') {
        json_free_values(values, 1);
        return_native_error(app->view, id, "INVALID_PATH",
            "The image path could not be read.");
        return;
    }

    const char *path = values[0];
    if (!image_path_was_scanned(path)) {
        json_free_values(values, 1);
        return_native_error(app->view, id, "IMAGE_PATH_UNKNOWN",
            "That image is not part of the directory that was opened.");
        return;
    }

    const char *mime = image_mime_type(path);
    if (mime == NULL) {
        json_free_values(values, 1);
        return_native_error(app->view, id, "UNSUPPORTED_IMAGE",
            "That file is not a supported image.");
        return;
    }

    /*
     * Bounded by the same per-file cap as the scan. A file that grew since the
     * walk is refused rather than read, so this cannot be used to pull an
     * arbitrarily large file into memory.
     */
    GStatBuf info;
    if (g_stat(path, &info) != 0 || info.st_size <= 0 ||
        (guint64)info.st_size > (guint64)IMAGE_SCAN_MAX_FILE_SIZE) {
        json_free_values(values, 1);
        return_native_error(app->view, id, "IMAGE_TOO_LARGE",
            "That image is no longer readable at full size.");
        return;
    }

    char *data_url = build_original_data_url(path, mime, (long long)info.st_size);
    if (data_url == NULL) {
        json_free_values(values, 1);
        return_native_error(app->view, id, "IMAGE_UNREADABLE",
            "That image could not be read.");
        return;
    }

    GString *response = g_string_new("{\"path\":");
    json_append_string(response, path);
    g_string_append(response, ",\"mime\":");
    json_append_string(response, mime);
    g_string_append(response, ",\"dataUrl\":");
    json_append_string(response, data_url);
    g_string_append(response, ",\"size\":");
    g_string_append_printf(response, "%lld}", (long long)info.st_size);
    g_free(data_url);
    json_free_values(values, 1);
    webview_return(app->view, id, 0, response->str);
    g_string_free(response, TRUE);
}
