#ifndef PDF_TOC_H
#define PDF_TOC_H

/*
 * Table-of-contents extraction for PDF documents (layer 2: pure work).
 *
 * This layer knows nothing about the webview: it turns a PDF on disk into a
 * pdf_toc, caches the result per document fingerprint, and serializes it to
 * the JSON the frontend expects. pdf_session.c owns the threading and the
 * bindings that call into here, which keeps the heuristics testable and
 * free of UI state.
 *
 * All returned char * values are owned by the caller (g_free/free as noted).
 */

#include <glib.h>

/* One extracted heading. title is owned by the pdf_toc that holds it. */
typedef struct {
    int page;
    int level;
    double position;
    char *title;
} pdf_heading;

/* Growing array of headings; release with pdf_toc_clear(). */
typedef struct {
    pdf_heading *items;
    size_t count;
} pdf_toc;

/* Identity of one extraction request: file, fingerprint, cache location. */
typedef struct {
    char *path;
    char *fingerprint;
    char *cache_path;
} pdf_toc_request;

/* Frees every title and the item array; safe to call twice in a row. */
void pdf_toc_clear(pdf_toc *toc);

/* Absolute path of the per-document cache file (creates the directory). Caller frees. */
char *toc_cache_path(const char *document_id);

/* Reads a matching cache entry into toc. Returns 1 only when headings landed. */
int read_cached_toc(const pdf_toc_request *request, pdf_toc *toc);

/* Best-effort write of the current toc; failures are silent by design. */
void write_cached_toc(const pdf_toc_request *request, const pdf_toc *toc);

/* Builds the {"documentId":...,"cached":...,"headings":[...]} reply. Caller frees. */
char *build_toc_response(const pdf_toc_request *request, const pdf_toc *toc, int cached);

/*
 * Extracts headings with pdftotext: TSV pass first (font sizes give levels),
 * plain-text pass as the fallback. Returns 1 when toc has at least one entry,
 * otherwise 0 with error set for a user-facing message.
 */
int extract_pdf_toc(const char *path, pdf_toc *toc, GError **error);

#endif /* PDF_TOC_H */
