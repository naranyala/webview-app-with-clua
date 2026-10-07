#ifndef IMAGE_DIRECTORY_H
#define IMAGE_DIRECTORY_H

/*
 * Image directory binding (layer 3: UI plumbing).
 *
 * Shows the folder chooser, walks it for supported images, and answers with one
 * entry per image: a *thumbnail* data URL for the grid, the absolute path, and
 * the original's size, plus a "limited" flag when a scan hit the depth, count,
 * or byte budget.
 *
 * Why a thumbnail and not the original: the grid renders entries at 140px tall
 * (`.image-thumbnail img` in index.css), so a 12 MP phone photo - 46 MB decoded
 * as RGBA, ~250 KB as a base64 string - would be retained for the whole session
 * to fill about 187x140 CSS pixels. Base64 also costs 33% over the raw bytes, so
 * the scan's byte budget is a floor on what is allocated rather than a limit on
 * it: 491 photos become ~120 MB resident in the JS heap. Downscaling in the scan
 * measured 105x smaller on this machine (4032x3024 -> 320px = 1,829 bytes), and
 * the full-resolution bytes are still one fetch away for the lightbox, which is
 * the only place that needs them.
 *
 * The scan itself never leaves this file: the budgets exist to keep a huge tree
 * from stalling the GTK main loop.
 *
 * Matches the webview_bind callback signature for main().
 */

#include "app_support.h"

/* Longest edge of the thumbnail handed to the grid, in pixels. */
#define IMAGE_THUMBNAIL_MAX_EDGE 320

/* JPEG quality for the thumbnail. 82 is visually clean at this size. */
#define IMAGE_THUMBNAIL_QUALITY "82"

/* Binds "openImageDirectory". */
void on_open_image_directory(const char *id, const char *request, void *argument);

/*
 * Binds "openImageDirectoryAt": scans the absolute path given as the request's
 * only argument, with no chooser, and answers with the same payload as
 * on_open_image_directory. This is what a re-selected entry of the webview's
 * recent-directories list calls.
 */
void on_open_image_directory_at(const char *id, const char *request, void *argument);

/*
 * Binds "loadImageAt": reads one image at full resolution and answers with a
 * data URL for it. The lightbox is the only caller, and it holds one image at a
 * time, so the cost is one decode rather than a collection.
 *
 * The request is [absolutePath]. A path is accepted only if the last scan
 * produced it: the scan records the absolute path of every image it offers, and
 * anything else is refused with IMAGE_PATH_UNKNOWN. Without that check this
 * binding would be a general file reader reachable from the page, which is a
 * capability the rest of the bridge deliberately does not have.
 */
void on_load_image_at(const char *id, const char *request, void *argument);

#endif /* IMAGE_DIRECTORY_H */
