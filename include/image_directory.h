#ifndef IMAGE_DIRECTORY_H
#define IMAGE_DIRECTORY_H

/*
 * Image directory binding (layer 3: UI plumbing).
 *
 * Shows the folder chooser, walks it for supported images, and answers with
 * base64 data URLs plus a "limited" flag when a scan hit the depth, count, or
 * byte budget. The scan itself never leaves this file: the budgets exist to
 * keep a huge tree from stalling the GTK main loop.
 *
 * Matches the webview_bind callback signature for main().
 */

#include "app_support.h"

/* Binds "openImageDirectory". */
void on_open_image_directory(const char *id, const char *request, void *argument);

#endif /* IMAGE_DIRECTORY_H */
