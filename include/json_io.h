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

/*
 * --- reading general JSON -------------------------------------------------
 *
 * The array reader above is deliberately narrow: it only understands
 * ["a","b"], which is all the text transfers need. The outline renderer needs
 * to walk a whole document the webview serializes, so this is the same codec
 * grown a general value tree. It stays in this module so there is still exactly
 * one place that decides what valid JSON is and how a string is escaped.
 *
 * A parsed document is a tree the caller owns and must release with
 * json_value_free(). Every accessor takes a possibly-wrong node and returns a
 * safe default rather than a fault, so a caller can walk an untrusted document
 * without checking types at every step.
 */

typedef enum {
    JSON_VALUE_NULL,
    JSON_VALUE_BOOL,
    JSON_VALUE_NUMBER,
    JSON_VALUE_STRING,
    JSON_VALUE_ARRAY,
    JSON_VALUE_OBJECT
} json_value_type;

typedef struct json_value json_value;

/* One key/value pair of an object; arrays keep the same nodes in `items`. */
typedef struct {
    char *name;
    json_value *value;
} json_member;

struct json_value {
    json_value_type type;
    int boolean;
    double number;
    /* Decoded and NUL-terminated for JSON_VALUE_STRING, else NULL. */
    char *text;
    /* Object pairs, or NULL. */
    json_member *members;
    /* Array elements, or NULL. */
    json_value **items;
    size_t count;
};

/*
 * Deepest nesting accepted. A recursive-descent parser on attacker-supplied
 * bytes needs a bound, or a document of ten thousand open brackets takes the
 * process down with a stack overflow - a crash reachable straight from a
 * webview call. The workspace outline never nests past a handful of levels.
 */
#define JSON_MAX_DEPTH 64

/*
 * Parses a complete JSON document. Returns NULL and sets *result on failure;
 * on success *result is JSON_OK. Trailing content after the value is an error,
 * so a truncated or doubled document is rejected instead of half-read.
 */
json_value *json_parse(const char *text, json_result *result);

/* Releases a tree from json_parse(). Safe on NULL. */
void json_value_free(json_value *value);

/* The member with this name in an object, or NULL (including on a non-object). */
const json_value *json_object_get(const json_value *object, const char *name);

/* The string at a node, or fallback when it is not a string. */
const char *json_string(const json_value *value, const char *fallback);

/* The number at a node, or fallback when it is not a number. */
double json_number(const json_value *value, double fallback);

/* The boolean at a node, or fallback when it is not a boolean. */
int json_bool(const json_value *value, int fallback);

/* Element count of an array or object, 0 for anything else. */
size_t json_count(const json_value *value);

/* The index'th element of an array, or NULL when out of range. */
const json_value *json_at(const json_value *array, size_t index);

#endif /* JSON_IO_H */
