#ifndef WORKSPACE_STORE_H
#define WORKSPACE_STORE_H

#include <stddef.h>

/* Upper bound for a stored workspace payload (serialized JSON). */
#define WORKSPACE_STORE_MAX_BYTES (4u * 1024u * 1024u)

typedef enum {
    WORKSPACE_STORE_OK = 0,
    WORKSPACE_STORE_ERR_NULL = -1,
    WORKSPACE_STORE_ERR_TOO_LARGE = -2,
    WORKSPACE_STORE_ERR_READ = -3,
    WORKSPACE_STORE_ERR_WRITE = -4,
    WORKSPACE_STORE_ERR_ARGUMENT = -5,
    WORKSPACE_STORE_ERR_OUT_OF_MEMORY = -6,
} workspace_store_result;

/* Returns a human-readable string for a workspace_store_result code. */
const char *workspace_store_strerror(workspace_store_result result);

/*
 * Reads the whole file at path into a NUL-terminated buffer.
 *
 * A missing file yields an empty buffer and WORKSPACE_STORE_OK, so callers can
 * distinguish "no state yet" from a read failure. Returns NULL on error and
 * stores the code in *result (when result is not NULL); on success the caller
 * owns the returned buffer and *length_out receives the byte count.
 */
char *workspace_store_load(const char *path, size_t *length_out,
                           workspace_store_result *result);

/*
 * Replaces path with data using a temporary file in the same directory and an
 * atomic rename, so an interrupted write cannot corrupt existing state.
 */
workspace_store_result workspace_store_save(const char *path, const char *data,
                                            size_t length);

/* Returns 1 when the buffer looks like a JSON object ({ ... }), else 0. */
int workspace_store_is_object(const char *data, size_t length);

/*
 * Decodes the first string element of a binding request argument list
 * ("[\"...\"]", including JSON escapes such as \\uXXXX).
 *
 * Returns a NUL-terminated buffer the caller must free, or NULL with the code
 * stored in *result (when result is not NULL).
 */
char *workspace_store_decode_argument(const char *request,
                                      workspace_store_result *result);

#endif
