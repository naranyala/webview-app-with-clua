#ifndef OUTLINE_PDF_H
#define OUTLINE_PDF_H

/*
 * Combined-outline PDF rendering (layer 3: UI plumbing).
 *
 * Turns the whole TOC Manager outline - every item's title as a heading and its
 * draft as body text, in outline order - into one paginated PDF inside a single
 * workspace directory. The result is an ordinary file, so the existing PDF
 * reader opens it as the preview with no new viewer and no special format.
 *
 * The layout is cairo's "toy" text API: measure with cairo_text_extents, wrap by
 * word, and paginate by hand. That is enough for a text document and avoids
 * pulling a typesetting engine into a host that otherwise has none. The
 * consequence is stated in the module: cairo's toy API does not shape complex
 * scripts, so Latin text is exact and other scripts may fall back imperfectly.
 *
 * Both functions match the webview_bind callback signature, so main() can
 * register them directly.
 */

#include "app_support.h"

/*
 * Binds "chooseOutlineDirectory": shows the folder chooser and answers with the
 * absolute path of the one workspace directory the combined PDF is written to.
 * The path is remembered on app_context so a later render needs no second
 * gesture.
 */
void on_choose_outline_directory(const char *id, const char *request, void *argument);

/*
 * Binds "renderOutlinePdf": writes the combined outline to
 * <workspace directory>/<suggested name> and answers with { path, name, pages,
 * bytes }.
 *
 * The request is ["suggestedName", "outlineJson"], where outlineJson is the
 * envelope the frontend already exports. The name is sanitized to a basename
 * and given a .pdf suffix, so it can never escape the chosen directory.
 * Requires on_choose_outline_directory to have run in this process.
 */
void on_render_outline_pdf(const char *id, const char *request, void *argument);

#endif /* OUTLINE_PDF_H */
