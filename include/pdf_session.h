#ifndef PDF_SESSION_H
#define PDF_SESSION_H

/*
 * Webview-facing PDF bindings (layer 3: UI plumbing).
 *
 * Owns everything that needs the webview or the GTK main loop for PDFs: the
 * open dialog, the current document identity on app_context, and the
 * background extraction of the table of contents. The heuristics themselves
 * live in pdf_toc.c so this file stays about orchestration.
 *
 * Both functions match the webview_bind callback signature, so main() can
 * register them directly.
 */

#include "app_support.h"

/* Binds "openPdf": shows the chooser, validates the file, answers with name/path/size/url/documentId. */
void on_open_pdf(const char *id, const char *request, void *argument);

/*
 * Binds "openPdfAt": opens the absolute path given as the request's only
 * argument, with no chooser, and answers with the same payload as on_open_pdf.
 * This is what a re-opened entry of the webview's recent-documents list calls,
 * so it rejects anything that is not an absolute path to a readable PDF.
 */
void on_open_pdf_at(const char *id, const char *request, void *argument);

/* Binds "extractPdfToc": starts one worker thread and answers when it finishes. */
void on_extract_pdf_toc(const char *id, const char *request, void *argument);

#endif /* PDF_SESSION_H */
