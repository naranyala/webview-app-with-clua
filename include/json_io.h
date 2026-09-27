#ifndef JSON_IO_H
#define JSON_IO_H

/*
 * The host's single JSON codec (layer 1: pure, no webview, no GTK).
 *
 * Every byte this process writes to the webview, and every binding request it
 * reads, goes through this module. Before it existed, five modules each
 * carried their own writer or decoder, which is how the protocol ended up with
 * four error shapes and two different notions of a valid string.
 *
 * Layering: this header pulls in no webview and no GTK symbol, so pure
 * computation (pdf_toc.c, webview_bridge.c) can use it without inheriting the
 * host's dependencies. Only the glue that answers a pending request lives
 * above it (return_native_error in app_support.c).
 */

#include <glib.h>
#include <stddef.h>

typedef enum {
    JSON_OK = 0,
    JSON_ERR_NULL = -1,      /* request pointer was NULL */
    JSON_ERR_MALFORMED = -2, /* not the expected ["...","..."] shape */
    JSON_ERR_CONTROL = -3,   /* a raw control byte inside a string */
    JSON_ERR_ESCAPE = -4,    /* an unknown, short, or unterminated escape */
    JSON_ERR_MEMORY = -5
} json_result;

/* Returns a human-readable string for a json_result code. */
const char *json_strerror(json_result result);

/* Appends "value" with surrounding quotes and full JSON escaping. */
void json_append_string(GString *output, const char *value);

/* Appends {"error":{"code":"...","message":"..."}} to output. */
void json_append_error(GString *output, const char *code, const char *message);

/*
 * Decodes exactly count strings from a binding request's argument list, which
 * the webview serializes as ["a", "b"]. Full JSON escapes are understood
 * (including \uXXXX with surrogate pairs); a raw control byte is rejected
 * rather than copied, so every binding validates a payload the same way.
 *
 * On success each values[i] is a NUL-terminated buffer of the exact decoded
 * length plus its terminator, owned by the caller; lengths[i] receives the
 * decoded length when lengths is not NULL. Use json_free_values() to release
 * them. On failure every buffer is released and NULL is returned with *result
 * set (when result is not NULL).
 */
json_result json_read_string_array(const char *request, size_t count,
                                   char **values, size_t *lengths);

/* Frees a values array filled by json_read_string_array(). */
void json_free_values(char **values, size_t count);

#endif /* JSON_IO_H */
