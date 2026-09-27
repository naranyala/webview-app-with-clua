/*
 * PDF table-of-contents extraction, cache, and JSON serialization.
 *
 * Pure work layer: no webview calls, no GTK, no app state. See
 * include/pdf_toc.h for the contract consumed by pdf_session.c.
 */

#include "pdf_toc.h"

#include "json_io.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* One physical line of pdftotext -tsv output, keyed for grouping. */
typedef struct {
    char *key;
    int page;
    double height;
    GString *title;
} text_line;

/* --- heading list -------------------------------------------------------- */

void pdf_toc_clear(pdf_toc *toc) {
    for (size_t index = 0; index < toc->count; index++) free(toc->items[index].title);
    free(toc->items);
    toc->items = NULL;
    toc->count = 0;
}

/*
 * Heading heuristics. Every threshold is named so a tuning change is a diff,
 * not a hunt through the parser.
 */
#define PDF_HEADING_TITLE_MAX_CHARS 180
#define PDF_HEADING_MAX_WORDS 12
#define PDF_HEADING_MIN_ALPHA_CHARS 2
#define PDF_HEADING_LARGE_RATIO 1.55
#define PDF_HEADING_MEDIUM_RATIO 1.25
#define PDF_HEADING_LEVEL1_RATIO 1.5

/* Counts UTF-8 characters, which is what the title cap is specified in. */
size_t pdf_toc_count_characters(const char *text) {
    size_t count = 0;
    for (const unsigned char *cursor = (const unsigned char *)text; *cursor != '\0'; cursor++) {
        if ((*cursor & 0xC0) != 0x80) count++;
    }
    return count;
}

/*
 * Appends one normalized heading. Titles are whitespace-collapsed, capped at
 * PDF_HEADING_TITLE_MAX_CHARS characters (not bytes, so a CJK or Cyrillic
 * heading is not silently dropped), and deduplicated against the previous
 * entry on the same page. Returns 1 when the heading was stored.
 */
static int append_heading(pdf_toc *toc, int page, int level, double position, const char *title) {
    GString *clean_title = g_string_new(NULL);
    pdf_heading *resized;

    for (const char *character = title; *character != '\0'; character++) {
        if (*character == '\t' || *character == '\r' || *character == '\n') g_string_append_c(clean_title, ' ');
        else if (*character != ' ' || clean_title->len == 0 || clean_title->str[clean_title->len - 1] != ' ') {
            g_string_append_c(clean_title, *character);
        }
    }
    g_strstrip(clean_title->str);
    if (clean_title->len == 0 || pdf_toc_count_characters(clean_title->str) > PDF_HEADING_TITLE_MAX_CHARS) {
        g_string_free(clean_title, TRUE);
        return 0;
    }
    if (toc->count > 0) {
        pdf_heading *previous = &toc->items[toc->count - 1];
        if (previous->page == page && g_strcmp0(previous->title, clean_title->str) == 0) {
            g_string_free(clean_title, TRUE);
            return 0;
        }
    }
    resized = realloc(toc->items, (toc->count + 1) * sizeof(*toc->items));
    if (resized == NULL) {
        g_string_free(clean_title, TRUE);
        return 0;
    }
    toc->items = resized;
    toc->items[toc->count++] = (pdf_heading){
        .page = page,
        .level = level,
        .position = position,
        .title = g_string_free(clean_title, FALSE),
    };
    return 1;
}

/* --- heading heuristics -------------------------------------------------- */

/* Digits or "chapter/section/appendix" prefixes mark an explicit heading. */
static int is_numbered_heading(const char *title) {
    while (*title == ' ') title++;
    if (g_ascii_isdigit(*title)) return 1;
    const char *prefixes[] = { "chapter ", "section ", "appendix " };
    for (size_t index = 0; index < G_N_ELEMENTS(prefixes); index++) {
        size_t length = strlen(prefixes[index]);
        if (g_ascii_strncasecmp(title, prefixes[index], length) != 0) continue;
        const char *number = title + length;
        while (*number == ' ') number++;
        return g_ascii_isdigit(*number);
    }
    return 0;
}

/* True when capitalization looks like a title ("Introduction") not prose. */
static int is_title_like(const char *title) {
    int alpha_count = 0;
    int uppercase_count = 0;
    int word_start = 1;
    int lowercase_word_start = 0;

    for (const unsigned char *character = (const unsigned char *)title; *character != '\0'; character++) {
        if (g_ascii_isalpha(*character)) {
            alpha_count++;
            if (g_ascii_isupper(*character)) uppercase_count++;
            if (word_start) {
                if (g_ascii_islower(*character)) lowercase_word_start = 1;
                word_start = 0;
            }
        } else if (g_ascii_isspace(*character)) {
            word_start = 1;
        }
    }
    return alpha_count >= 2 && (uppercase_count == alpha_count || !lowercase_word_start);
}

/*
 * Decides whether a line is a heading using length, punctuation, word count,
 * and (for the TSV pass) how much bigger it is than the body-font median.
 */
static int is_text_heading(const char *title, double size_ratio) {
    int alpha_count = 0;
    int word_count = 1;
    size_t length = g_utf8_strlen(title, -1);
    const char *last = title + strlen(title) - 1;

    if (length < 2 || length > 100 || (last[0] == '.' || last[0] == ',' || last[0] == ';' || last[0] == ':')) return 0;
    for (const unsigned char *character = (const unsigned char *)title; *character != '\0'; character++) {
        if (g_ascii_isalpha(*character)) alpha_count++;
        if (*character == ' ') word_count++;
    }
    if (alpha_count < PDF_HEADING_MIN_ALPHA_CHARS || word_count > PDF_HEADING_MAX_WORDS) return 0;
    if (is_numbered_heading(title)) return 1;
    if (size_ratio >= PDF_HEADING_LARGE_RATIO) return is_title_like(title);
    return size_ratio >= PDF_HEADING_MEDIUM_RATIO && is_title_like(title);
}

/* Ascending qsort comparator that handles doubles without subtracting into int. */
static int compare_double(const void *left, const void *right) {
    double difference = *(const double *)left - *(const double *)right;
    return (difference > 0) - (difference < 0);
}

/* --- pdftotext ----------------------------------------------------------- */

/* Runs pdftotext with one extra option, capturing stdout into output. */
static int run_pdftotext(const char *path, const char *option, char **output, GError **error) {
    char *arguments[] = {
        (char *)PDFTOTEXT_EXECUTABLE, (char *)"-q", (char *)"-enc", (char *)"UTF-8",
        (char *)option, (char *)path, (char *)"-", NULL,
    };
    int wait_status = 0;
    g_spawn_sync(NULL, arguments, NULL, G_SPAWN_SEARCH_PATH, NULL, NULL,
        output, NULL, &wait_status, error);
    return error == NULL || *error == NULL;
}

/*
 * Parses `pdftotext -tsv` output. Rows with level "5" are text runs; runs that
 * share a position are one line. Heading level comes from the line's height
 * compared with the median body height of the page.
 */
static int extract_tsv_headings(const char *text, pdf_toc *toc) {
    char **rows = g_strsplit(text, "\n", -1);
    text_line *lines = NULL;
    size_t line_count = 0;
    double *heights = NULL;

    for (char **row = rows; *row != NULL; row++) {
        if (g_ascii_strncasecmp(*row, "level\t", 6) == 0 || strchr(*row, '\t') == NULL) continue;
        char **fields = g_strsplit(*row, "\t", -1);
        int field_count = g_strv_length(fields);
        if (field_count < 12 || strcmp(fields[0], "5") != 0) {
            g_strfreev(fields);
            continue;
        }
        char *key = g_strdup_printf("%s:%s:%s:%s", fields[1], fields[2], fields[3], fields[4]);
        if (line_count == 0 || g_strcmp0(lines[line_count - 1].key, key) != 0) {
            text_line *resized = realloc(lines, (line_count + 1) * sizeof(*lines));
            if (resized == NULL) {
                g_free(key);
                g_strfreev(fields);
                g_strfreev(rows);
                return 0;
            }
            lines = resized;
            lines[line_count++] = (text_line){
                .key = key,
                .page = atoi(fields[1]),
                .height = g_ascii_strtod(fields[9], NULL),
                .title = g_string_new(NULL),
            };
        } else {
            g_free(key);
        }
        if (lines[line_count - 1].title->len > 0) g_string_append_c(lines[line_count - 1].title, ' ');
        g_string_append(lines[line_count - 1].title, fields[11]);
        g_strfreev(fields);
    }
    g_strfreev(rows);

    if (line_count == 0) {
        free(lines);
        return 0;
    }
    heights = g_new(double, line_count);
    for (size_t index = 0; index < line_count; index++) heights[index] = lines[index].height;
    qsort(heights, line_count, sizeof(double), compare_double);
    double body_height = line_count % 2 == 0
        ? heights[line_count / 2 - 1]
        : heights[line_count / 2];
    if (body_height <= 0) body_height = 1;

    for (size_t index = 0; index < line_count; index++) {
        double ratio = lines[index].height / body_height;
        if (is_text_heading(lines[index].title->str, ratio)) {
            int level = is_numbered_heading(lines[index].title->str) || ratio >= PDF_HEADING_LEVEL1_RATIO ? 1 : ratio >= PDF_HEADING_MEDIUM_RATIO ? 2 : 3;
            append_heading(toc, lines[index].page, level, lines[index].height, lines[index].title->str);
        }
        g_string_free(lines[index].title, TRUE);
        g_free(lines[index].key);
    }
    g_free(heights);
    free(lines);
    return 1;
}

/* Fallback pass over `pdftotext -layout`: line-based, page = form feeds. */
static int extract_text_headings(const char *text, pdf_toc *toc) {
    int page = 1;
    for (const char *cursor = text; *cursor != '\0';) {
        const char *end = strchr(cursor, '\n');
        if (end == NULL) end = cursor + strlen(cursor);
        char *line = g_strndup(cursor, end - cursor);
        g_strstrip(line);
        if (is_text_heading(line, 1)) append_heading(toc, page, is_numbered_heading(line) ? 1 : 2, 0, line);
        if (*end == '\f') page++;
        g_free(line);
        cursor = *end == '\0' ? end : end + 1;
    }
    return toc->count > 0;
}

int extract_pdf_toc(const char *path, pdf_toc *toc, GError **error) {
    char *output = NULL;
    if (!run_pdftotext(path, "-tsv", &output, error)) {
        g_free(output);
        return 0;
    }
    extract_tsv_headings(output, toc);
    g_free(output);
    output = NULL;
    if (toc->count == 0 && !run_pdftotext(path, "-layout", &output, error)) {
        g_free(output);
        g_clear_error(error);
        g_set_error(error, G_FILE_ERROR, G_FILE_ERROR_FAILED, "Could not read text from the selected PDF.");
        return 0;
    }
    if (toc->count == 0) extract_text_headings(output, toc);
    g_free(output);
    if (toc->count == 0) {
        g_set_error(error, G_FILE_ERROR, G_FILE_ERROR_FAILED, "No headings could be extracted from this PDF.");
        return 0;
    }
    return 1;
}

/* --- per-document cache -------------------------------------------------- */

/* $XDG_DATA_DIR/native-workspace/pdf-toc/<document_id>, created on demand. */
char *toc_cache_path(const char *document_id) {
    char *directory = g_build_filename(g_get_user_data_dir(), "native-workspace", "pdf-toc", NULL);
    g_mkdir_with_parents(directory, 0700);
    char *path = g_build_filename(directory, document_id, NULL);
    g_free(directory);
    return path;
}

/*
 * Reads a cache file written by write_cached_toc. The first line is a format
 * marker and the second the document fingerprint, so a changed file never
 * reuses stale headings.
 */
int read_cached_toc(const pdf_toc_request *request, pdf_toc *toc) {
    char *contents = NULL;
    if (!g_file_get_contents(request->cache_path, &contents, NULL, NULL)) return 0;
    char **rows = g_strsplit(contents, "\n", -1);
    int valid = g_strv_length(rows) >= 2 && g_strcmp0(rows[0], "native-workspace-pdf-toc-v1") == 0 &&
                g_strcmp0(rows[1], request->fingerprint) == 0;
    if (valid) {
        for (size_t index = 2; index < g_strv_length(rows) && rows[index][0] != '\0'; index++) {
            char **fields = g_strsplit(rows[index], "\t", -1);
            if (g_strv_length(fields) == 5) {
                gsize title_length = 0;
                char *title = (char *)g_base64_decode(fields[4], &title_length);
                if (title != NULL && append_heading(toc, atoi(fields[1]), atoi(fields[3]), g_ascii_strtod(fields[2], NULL), title)) {
                    free(toc->items[toc->count - 1].title);
                    toc->items[toc->count - 1].title = title;
                } else {
                    g_free(title);
                }
            }
            g_strfreev(fields);
        }
    }
    g_strfreev(rows);
    g_free(contents);
    return valid && toc->count > 0;
}

/* Writes the marker + fingerprint + one base64-encoded title per heading. */
void write_cached_toc(const pdf_toc_request *request, const pdf_toc *toc) {
    GString *contents = g_string_new("native-workspace-pdf-toc-v1\n");
    g_string_append_printf(contents, "%s\n", request->fingerprint);
    for (size_t index = 0; index < toc->count; index++) {
        char *encoded = g_base64_encode((const guchar *)toc->items[index].title, strlen(toc->items[index].title));
        g_string_append_printf(contents, "H\t%d\t%.2f\t%d\t%s\n", toc->items[index].page,
            toc->items[index].position, toc->items[index].level, encoded);
        g_free(encoded);
    }
    g_file_set_contents(request->cache_path, contents->str, contents->len, NULL);
    g_string_free(contents, TRUE);
}

/* Serializes toc to the JSON shape expected by the TOC Manager sidebar. */
char *build_toc_response(const pdf_toc_request *request, const pdf_toc *toc, int cached) {
    GString *response = g_string_new("{\"documentId\":");
    g_string_append_printf(response, "\"%s\",\"cached\":%s,\"headings\":[", request->fingerprint, cached ? "true" : "false");
    for (size_t index = 0; index < toc->count; index++) {
        if (index > 0) g_string_append_c(response, ',');
        g_string_append_printf(response, "{\"page\":%d,\"level\":%d,\"position\":%.2f,\"title\":",
            toc->items[index].page, toc->items[index].level, toc->items[index].position);
        json_append_string(response, toc->items[index].title);
        g_string_append_c(response, '}');
    }
    g_string_append(response, "]}");
    return g_string_free(response, FALSE);
}
