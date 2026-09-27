/*
 * Combined-outline PDF rendering. See include/outline_pdf.h for the contract.
 *
 * Everything here is deliberately text-only. The TOC Manager's job is to collect
 * the drafts an author has written, and a PDF that renders them in outline order
 * is exactly what the "combine" action promises. Embedding figures or map tiles
 * is a separate and much larger problem (decoding, scaling, paging images) and is
 * not silently half-done here.
 *
 * The writing order is: parse the envelope the frontend already exports, then for
 * each item emit a heading sized by its level followed by its body text,
 * word-wrapped to the measure. A new page starts whenever the next line would
 * cross the bottom margin, so no line is ever clipped.
 */

#include "outline_pdf.h"

#include "json_io.h"

#include <cairo.h>
#include <cairo-pdf.h>
#include <glib/gstdio.h>
#include <gtk/gtk.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* A4 in PostScript points, which is also the PDF user-space unit. */
#define PAGE_WIDTH 595.28
#define PAGE_HEIGHT 841.89
#define MARGIN 56.0
#define BODY_SIZE 10.5
#define SPACE_BEFORE_HEADING 16.0
#define SPACE_AFTER_HEADING 6.0
#define SPACE_BETWEEN_ITEMS 12.0
#define PARAGRAPH_GAP 8.0
/*
 * Room kept below a heading for at least one line of its body. A heading that
 * lands last on a page with its text overleaf is the classic widow, and the
 * cost of the extra space is one break earlier.
 */
#define MIN_BODY_LINE 14.0

/* An outline larger than this is not a document; refuse rather than grind. */
#define MAX_ITEMS 10000

static const double heading_sizes[3] = { 18.0, 15.0, 12.5 };

/*
 * The layout cursor and the page geometry, in one place, so the "does this line
 * still fit" test and the drawing that follows can never disagree.
 */
typedef struct {
    cairo_t *context;
    double cursor_y;
    double measure;
    int page;
} layout;

/* --- page flow ------------------------------------------------------------ */

/*
 * Starts a page: an opaque white background, then the top margin.
 *
 * The background matters: a PDF page is transparent by default, and a viewer
 * over a dark theme would otherwise show the text on whatever the page is
 * composited over. The size is restated on every page because a PDF surface
 * keeps one page size for the whole document otherwise.
 */
static void begin_page(layout *state) {
    cairo_save(state->context);
    cairo_pdf_surface_set_size(cairo_get_target(state->context), PAGE_WIDTH, PAGE_HEIGHT);
    cairo_set_source_rgb(state->context, 1, 1, 1);
    cairo_rectangle(state->context, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    cairo_fill(state->context);
    cairo_restore(state->context);
    /*
     * Cairo's y axis points up, so the cursor starts at the top margin and
     * increases toward the bottom one. (Treating it as a DOM-style downward
     * offset made the first line look like it was already past the bottom.)
     */
    state->cursor_y = MARGIN;
    state->page += 1;
}

static void flush_page(layout *state) {
    cairo_show_page(state->context);
    begin_page(state);
}

/* Whether one more line of `height` still fits above the bottom margin. */
static int fits(const layout *state, double height) {
    return state->cursor_y + height <= PAGE_HEIGHT - MARGIN;
}

/* --- text helpers --------------------------------------------------------- */

/*
 * The full line box of the current font, not just the ascent. Using the ascent
 * alone makes leading depend on the glyphs in the line and drifts down the page;
 * the height plus descent is stable for a given size.
 */
static double line_height(cairo_t *context) {
    cairo_font_extents_t extents;
    cairo_font_extents(context, &extents);
    double height = extents.height + extents.descent;
    return height > 0 ? height : 14.0;
}

static double text_width(cairo_t *context, const char *text) {
    cairo_text_extents_t extents;
    cairo_text_extents(context, text, &extents);
    return extents.x_advance;
}

/* Draws one line at the cursor and advances it. The caller has checked it fits. */
static void draw_line(layout *state, const char *text) {
    cairo_font_extents_t extents;
    cairo_font_extents(state->context, &extents);
    /* The cursor is the top of the line box, so the baseline sits below it. */
    cairo_move_to(state->context, MARGIN, state->cursor_y + extents.ascent);
    cairo_show_text(state->context, text);
    state->cursor_y += line_height(state->context);
}

/*
 * Drops the last character unless doing so would land inside a multi-byte UTF-8
 * sequence. Cairo's toy API takes UTF-8 and has no shaping, so a split sequence
 * would be drawn as mojibake; backing off to a boundary costs nothing on ASCII
 * and keeps other scripts at least readable.
 */
static void truncate_one_character(GString *line) {
    if (line->len == 0) return;
    g_string_truncate(line, line->len - 1);
    while (line->len > 0 && ((unsigned char)line->str[line->len - 1] & 0xc0) == 0x80) {
        g_string_truncate(line, line->len - 1);
    }
}

/* Draws the buffered line if it holds anything, then empties the buffer. */
static void flush_wrapped_line(layout *state, GString *line) {
    if (line->len == 0) return;
    if (!fits(state, line_height(state->context))) flush_page(state);
    draw_line(state, line->str);
    g_string_truncate(line, 0);
}

/*
 * Draws `text` word-wrapped to the measure, breaking at spaces and tabs.
 *
 * A word too long for a whole line is split at a character boundary and the
 * remainder continues on the next line. Silently dropping the overflow would
 * lose part of a draft, which for a document builder is the one unacceptable
 * failure.
 */
static void draw_wrapped(layout *state, const char *text) {
    GString *line = g_string_new(NULL);
    const char *cursor = text;

    while (cursor != NULL) {
        const char *end = cursor;
        while (*end != '\0' && *end != ' ' && *end != '\t' && *end != '\n') end++;
        size_t length = (size_t)(end - cursor);

        if (length > 0) {
            size_t base;
            /* The space between words is added here, not carried over from the
               source: the wrap loop consumes the separators, so a line assembled
               without this renders every sentence as one run-on word. */
            if (line->len > 0) g_string_append_c(line, ' ');
            base = line->len;
            g_string_append_len(line, cursor, length);
            if (text_width(state->context, line->str) <= state->measure) {
                /* The word fits on the current line; keep it there. */
            } else {
                const char *word = cursor;
                const char *placed_end;
                size_t remaining = length;
                /* Draw what came before the word, then continue on a fresh line. */
                g_string_truncate(line, base);
                flush_wrapped_line(state, line);
                /* Place as much of the word as will fit. Each iteration that
                   does not fit drops the last character and advances `word`, so
                   on exit the line holds [cursor, placed_end). */
                while (remaining > 0) {
                    g_string_append_len(line, word, remaining);
                    if (text_width(state->context, line->str) <= state->measure) break;
                    truncate_one_character(line);
                    word += 1;
                    remaining -= 1;
                }
                /*
                 * Was the word split, or did it fit whole?
                 *
                 * `word` alone cannot say: it is unchanged when nothing was
                 * dropped and points inside the word when something was, so
                 * both cases need telling apart explicitly. Reading the
                 * unplaced remainder as [word, end) in the no-drop case would
                 * re-append the entire word and print it twice.
                 */
                placed_end = (word == cursor) ? end : word;
                if (placed_end < end) {
                    /* Only a split word closes its line; a whole one stays in
                       the buffer so the next word continues after it. */
                    flush_wrapped_line(state, line);
                    g_string_append_len(line, placed_end, (size_t)(end - placed_end));
                }
            }
        }
        while (*end == ' ' || *end == '\t' || *end == '\n') end++;
        cursor = (*end == '\0') ? NULL : end;
    }
    flush_wrapped_line(state, line);
    g_string_free(line, TRUE);
}

/* --- items ---------------------------------------------------------------- */

static int clamp_level(const json_value *item) {
    double declared = json_number(json_object_get(item, "level"), 1);
    long rounded = lround(declared);
    if (rounded < 1) return 0;
    if (rounded > 3) return 2;
    return (int)(rounded - 1);
}

static void draw_heading(layout *state, const char *title, int level_index) {
    cairo_font_extents_t extents;
    double size = heading_sizes[level_index];
    /* A deeper level is set slightly smaller and indented, so nesting is
       visible on the page without relying on size alone. */
    double indent = (double)level_index * 18.0;

    state->cursor_y += SPACE_BEFORE_HEADING;
    cairo_select_font_face(state->context, "sans-serif", CAIRO_FONT_SLANT_NORMAL,
        CAIRO_FONT_WEIGHT_BOLD);
    cairo_set_font_size(state->context, size);
    cairo_font_extents(state->context, &extents);
    /* The heading plus a body line, so no heading is stranded at a page foot. */
    if (!fits(state, extents.height + SPACE_AFTER_HEADING + MIN_BODY_LINE)) {
        flush_page(state);
    }
    cairo_set_source_rgb(state->context, 0.06, 0.08, 0.11);
    cairo_move_to(state->context, MARGIN + indent, state->cursor_y + extents.ascent);
    cairo_show_text(state->context, title);
    state->cursor_y += extents.height + SPACE_AFTER_HEADING;
}

static void draw_body(layout *state, const char *text) {
    cairo_select_font_face(state->context, "serif", CAIRO_FONT_SLANT_NORMAL,
        CAIRO_FONT_WEIGHT_NORMAL);
    cairo_set_font_size(state->context, BODY_SIZE);
    cairo_set_source_rgb(state->context, 0.13, 0.14, 0.16);
    draw_wrapped(state, text);
    state->cursor_y += PARAGRAPH_GAP;
}

/*
 * Draws one item's paragraphs. A run of blank lines in the draft becomes a
 * paragraph break, so the structure the author typed survives instead of
 * collapsing into one run-on block.
 */
static void draw_paragraphs(layout *state, const char *content) {
    GString *paragraph = g_string_new(NULL);
    const char *start = content;
    const char *cursor = content;

    for (;;) {
        if (*cursor == '\n' || *cursor == '\0') {
            size_t length = (size_t)(cursor - start);
            if (length > 0) {
                if (paragraph->len > 0) {
                    draw_body(state, paragraph->str);
                    g_string_truncate(paragraph, 0);
                }
                g_string_append_len(paragraph, start, length);
            }
            if (*cursor == '\0') break;
            start = cursor + 1;
        }
        cursor++;
    }
    if (paragraph->len > 0) draw_body(state, paragraph->str);
    g_string_free(paragraph, TRUE);
}

static void draw_item(layout *state, const json_value *item) {
    const char *title = json_string(json_object_get(item, "title"), NULL);
    const char *content = json_string(json_object_get(item, "content"), "");

    if (title == NULL || title[0] == '\0') return;
    state->cursor_y += SPACE_BETWEEN_ITEMS;
    draw_heading(state, title, clamp_level(item));
    if (content != NULL && content[0] != '\0') draw_paragraphs(state, content);
}

/* --- rendering ------------------------------------------------------------ */

/* Draws the document and returns the page count. */
static int render_outline(cairo_t *context, const json_value *root) {
    layout state;
    const json_value *items = json_object_get(root, "items");
    size_t total = json_count(items);
    const char *title = json_string(json_object_get(root, "title"), NULL);

    if (total > MAX_ITEMS) total = MAX_ITEMS;
    state.context = context;
    state.measure = PAGE_WIDTH - 2 * MARGIN;
    state.page = 0;
    state.cursor_y = MARGIN;
    begin_page(&state);

    /* A cover line so a combined document is not a wall of body text with no
       indication of what it is. */
    if (title != NULL && title[0] != '\0') {
        draw_heading(&state, title, 0);
        state.cursor_y += 4.0;
    }
    if (total == 0) {
        draw_body(&state, "This outline has no items yet.");
    }
    for (size_t index = 0; index < total; index++) {
        const json_value *item = json_at(items, index);
        if (item != NULL) draw_item(&state, item);
    }
    return state.page;
}

/* --- names ---------------------------------------------------------------- */

/*
 * Reduces a suggested name to a safe basename: no directory separators, no
 * parent references, nothing that could land the file outside the chosen
 * workspace directory. Control characters and the characters Windows rejects go
 * too, so the same name keeps working if the workspace is ever shared.
 */
static char *sanitize_pdf_name(const char *suggested) {
    GString *name = g_string_new(NULL);
    const char *base = (suggested != NULL) ? suggested : "";

    for (const char *scan = base; *scan != '\0'; scan++) {
        if (*scan == '/' || *scan == '\\') base = scan + 1;
    }
    for (const char *cursor = base; *cursor != '\0'; cursor++) {
        unsigned char character = (unsigned char)*cursor;
        if (character < 0x20 || character == 0x7f) continue;
        if (strchr("\\/:*?\"<>|", character) != NULL) continue;
        g_string_append_c(name, (char)character);
    }
    /* A name of only dots would resolve to the directory itself. */
    while (name->len > 0 && strspn(name->str, ".") == name->len) {
        g_string_truncate(name, name->len - 1);
    }
    if (name->len == 0) {
        g_string_assign(name, "outline.pdf");
    } else if (name->len <= 120 && !g_str_has_suffix(name->str, ".pdf")) {
        g_string_append(name, ".pdf");
    } else if (name->len > 120) {
        g_string_truncate(name, 120);
        if (!g_str_has_suffix(name->str, ".pdf")) g_string_append(name, ".pdf");
    }
    return g_string_free(name, FALSE);
}

/* --- chooseOutlineDirectory ------------------------------------------------ */

/*
 * Runs on the GTK main loop after dispatch_picker(): ask for the one workspace
 * directory, then remember it so a later render needs no second gesture.
 */
static void show_outline_directory_picker(webview_t view, void *argument) {
    picker_request *request = argument;
    char *selected = run_path_chooser(view, PICKER_SELECT_FOLDER,
        "Choose Workspace Folder", NULL, NULL);
    GString *response = NULL;

    if (selected == NULL) {
        webview_return(view, request->request_id, 0, "{\"canceled\":true}");
    } else {
        app_context *app = request->app;
        g_free(app->outline_dir);
        app->outline_dir = g_strdup(selected);
        response = g_string_new(NULL);
        g_string_append(response, "{\"path\":");
        json_append_string(response, selected);
        g_string_append(response, ",\"name\":");
        json_append_string(response, g_path_get_basename(selected));
        g_string_append_c(response, '}');
        webview_return(view, request->request_id, 0, response->str);
        g_string_free(response, TRUE);
    }
    g_free(selected);
    picker_request_release(request);
}

void on_choose_outline_directory(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    (void)request;
    dispatch_picker(app, id, show_outline_directory_picker, "workspace folder chooser");
}

/* --- renderOutlinePdf ----------------------------------------------------- */

void on_render_outline_pdf(const char *id, const char *request, void *argument) {
    app_context *app = argument;
    char *values[2] = { NULL, NULL };
    json_result decoded = json_read_string_array(request, 2, values, NULL);
    json_value *root = NULL;
    json_result parse_status = JSON_OK;
    char *name = NULL;
    char *path = NULL;
    cairo_surface_t *surface = NULL;
    cairo_t *context = NULL;
    GString *response = NULL;
    GStatBuf info;
    int pages = 0;

    if (decoded != JSON_OK) {
        return_native_error(app->view, id, "INVALID_ARGUMENT",
            "The outline request could not be read.");
        return;
    }
    /* The directory has to have come from the chooser in this process, so the
       webview cannot ask for a write anywhere the user never named. */
    if (app->outline_dir == NULL || app->outline_dir[0] == '\0') {
        return_native_error(app->view, id, "NO_WORKSPACE_DIRECTORY",
            "Choose the workspace folder before combining the outline.");
        json_free_values(values, 2);
        return;
    }

    root = json_parse(values[1], &parse_status);
    if (root == NULL || root->type != JSON_VALUE_OBJECT) {
        return_native_error(app->view, id, "INVALID_OUTLINE",
            "The outline could not be read as JSON.");
        goto cleanup;
    }

    name = sanitize_pdf_name(values[0]);
    path = g_build_filename(app->outline_dir, name, NULL);
    surface = cairo_pdf_surface_create(path, PAGE_WIDTH, PAGE_HEIGHT);
    if (surface == NULL || cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        return_native_error(app->view, id, "WRITE_FAILED",
            "The PDF file could not be created in the workspace folder.");
        goto cleanup;
    }
    context = cairo_create(surface);
    if (cairo_status(context) != CAIRO_STATUS_SUCCESS) {
        return_native_error(app->view, id, "WRITE_FAILED",
            "The PDF renderer could not start.");
        goto cleanup;
    }

    pages = render_outline(context, root);
    cairo_destroy(context);
    context = NULL;
    cairo_surface_finish(surface);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        return_native_error(app->view, id, "WRITE_FAILED",
            "The combined PDF could not be written.");
        goto cleanup;
    }
    cairo_surface_destroy(surface);
    surface = NULL;

    if (g_stat(path, &info) != 0) {
        return_native_error(app->view, id, "WRITE_FAILED",
            "The combined PDF was not written where expected.");
        goto cleanup;
    }

    response = g_string_new(NULL);
    g_string_append(response, "{\"path\":");
    json_append_string(response, path);
    g_string_append(response, ",\"name\":");
    json_append_string(response, name);
    g_string_append_printf(response, ",\"pages\":%d,\"bytes\":%ld}", pages,
        (long)info.st_size);
    webview_return(app->view, id, 0, response->str);

cleanup:
    if (response != NULL) g_string_free(response, TRUE);
    if (context != NULL) cairo_destroy(context);
    if (surface != NULL) cairo_surface_destroy(surface);
    if (root != NULL) json_value_free(root);
    g_free(path);
    g_free(name);
    json_free_values(values, 2);
}
