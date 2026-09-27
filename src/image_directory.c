/*
 * Folder chooser and bounded recursive scan for the Image Viewer.
 *
 * See include/image_directory.h for the layer contract.
 */

#include "image_directory.h"

#include "json_io.h"

#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Scan budgets: a runaway tree must never stall the GTK main loop. */
#define IMAGE_SCAN_MAX_DEPTH 8
#define IMAGE_SCAN_MAX_FILES 500
#define IMAGE_SCAN_MAX_FILE_SIZE (16LL * 1024LL * 1024LL)
#define IMAGE_SCAN_MAX_TOTAL_SIZE (96LL * 1024LL * 1024LL)

/* Accumulator for one scan: the JSON array under construction plus totals. */
typedef struct {
    GString *json;
    size_t count;
    long long total_size;
    int limited;
} image_scan_result;

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
 * Depth-first walk that appends every accepted image as a base64 data URL.
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
            char *contents = NULL;
            gsize length = 0;
            if (g_file_get_contents(path, &contents, &length, NULL) && length == (gsize)size) {
                char *encoded = g_base64_encode((const guchar *)contents, length);
                if (encoded != NULL) {
                    if (result->count > 0) g_string_append_c(result->json, ',');
                    g_string_append(result->json, "{\"name\":");
                    json_append_string(result->json, entry);
                    g_string_append(result->json, ",\"relativePath\":");
                    json_append_string(result->json, relative_path);
                    g_string_append_printf(result->json, ",\"size\":%lld,\"dataUrl\":\"data:%s;base64,%s\"}", size, mime, encoded);
                    result->count++;
                    result->total_size += size;
                }
                g_free(encoded);
            }
            g_free(contents);
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
 * Runs on the GTK main loop after dispatch_picker(): pick a folder, scan it,
 * and answer with {"images":[...],"name":...,"limited":...} or NO_IMAGES.
 */
static void show_image_directory_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected_path = run_path_chooser(view, PICKER_SELECT_FOLDER, "Choose Image Directory", NULL, NULL);
    if (selected_path == NULL) {
        webview_return(view, request->request_id, 0, "{\"canceled\":true}");
        goto cleanup;
    }

    image_scan_result scan = { .json = g_string_new("{\"images\":[") };
    scan_image_directory(selected_path, "", 0, &scan);
    char *directory_name = g_path_get_basename(selected_path);
    g_string_append_c(scan.json, ']');
    g_string_append(scan.json, ",\"name\":");
    json_append_string(scan.json, directory_name);
    g_string_append_printf(scan.json, ",\"limited\":%s}", scan.limited ? "true" : "false");
    if (scan.count == 0) {
        return_native_error(view, request->request_id, "NO_IMAGES", "No supported images were found within the directory limits.");
    } else {
        webview_return(view, request->request_id, 0, scan.json->str);
    }
    g_free(directory_name);
    g_string_free(scan.json, TRUE);

cleanup:
    g_free(selected_path);
    picker_request_release(request);
}

void on_open_image_directory(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    dispatch_picker(app, id, show_image_directory_picker, "image directory picker");
}
