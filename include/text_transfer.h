#ifndef TEXT_TRANSFER_H
#define TEXT_TRANSFER_H

/*
 * Webview-facing text file bindings (layer 3: UI plumbing).
 *
 * Owns the import/export transfers used by the TOC Manager and the Text
 * Editor: one binding opens the system picker and reads a text file, the
 * other opens the save picker and writes the payload the frontend hands it.
 * Argument decoding and file-name sanitizing stay pure so tests can cover
 * them without a GTK main loop; the chooser itself runs only through
 * dispatch_picker().
 *
 * Both functions match the webview_bind callback signature, so main() can
 * register them directly.
 */

#include "app_support.h"

/* Largest text payload a transfer will read or write (8 MiB). */
#define TEXT_TRANSFER_MAX_BYTES (8u * 1024u * 1024u)

/* Outcome of decoding the saveTextFile argument list. */
typedef enum {
    TEXT_TRANSFER_OK = 0,
    TEXT_TRANSFER_ERR_NULL = 1,
    TEXT_TRANSFER_ERR_ARGUMENT = 2,
    TEXT_TRANSFER_ERR_TOO_LARGE = 3,
    TEXT_TRANSFER_ERR_MEMORY = 4,
} text_transfer_status;

/*
 * Decodes the WebView request ["<name>","<content>"] into two malloc'd
 * strings (JSON escapes resolved, including surrogate pairs). Either output
 * is set only on success; the caller frees both with free().
 */
text_transfer_status text_transfer_decode_save_request(const char *request, char **name, char **content);

/*
 * Turns a suggested file name into a safe base name: keeps only the final
 * path segment, replaces separators and reserved characters, trims leading
 * dots and trailing dots/spaces, and caps the result on a UTF-8 boundary.
 * Returns a malloc'd string; an empty result falls back to fallback.
 */
char *text_transfer_suggest_name(const char *requested, const char *fallback);

/* Human-readable message for a decode failure (never NULL). */
const char *text_transfer_strerror(text_transfer_status status);

/* Binds "openTextFile": system open picker, answers with name/path/content. */
void on_open_text_file(const char *id, const char *request, void *argument);

/* Binds "saveTextFile": system save picker, answers with name/path/bytes. */
void on_save_text_file(const char *id, const char *request, void *argument);

#endif /* TEXT_TRANSFER_H */
