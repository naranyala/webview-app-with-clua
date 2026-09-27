/*
 * Durable JSON workspace store.
 *
 * workspace_store_load/save keep $XDG_DATA_HOME/native-workspace/workspace.json
 * inside WORKSPACE_STORE_MAX_BYTES by writing a temporary file and renaming it
 * over the target, and report a workspace_store_result instead of reading
 * errno, so the webview bindings can map failures onto protocol codes.
 *
 * The second half is a small JSON scanner (is_object, decode_argument) used to
 * validate the saveWorkspace argument and unescape its string payload without
 * linking a JSON library.
 */

#include "workspace_store.h"

#include "json_io.h"

#include <gio/gio.h>

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>

const char *workspace_store_strerror(workspace_store_result result) {
    switch (result) {
        case WORKSPACE_STORE_OK:
            return "ok";
        case WORKSPACE_STORE_ERR_NULL:
            return "a required argument was NULL";
        case WORKSPACE_STORE_ERR_TOO_LARGE:
            return "the workspace payload exceeds the storage limit";
        case WORKSPACE_STORE_ERR_READ:
            return "the workspace file could not be read";
        case WORKSPACE_STORE_ERR_WRITE:
            return "the workspace file could not be written";
        case WORKSPACE_STORE_ERR_ARGUMENT:
            return "the request argument is not a JSON string";
        case WORKSPACE_STORE_ERR_OUT_OF_MEMORY:
            return "memory allocation failed";
    }
    return "unknown workspace error";
}

static void store_result_set(workspace_store_result *target,
                             workspace_store_result value) {
    if (target != NULL) *target = value;
}

/* Reads the whole file into a caller-owned buffer, or reports why it could not. */
char *workspace_store_load(const char *path, size_t *length_out,
                           workspace_store_result *result) {
    workspace_store_result status = WORKSPACE_STORE_OK;
    char *contents = NULL;
    gsize length = 0;
    GError *error = NULL;

    if (length_out != NULL) *length_out = 0;
    if (path == NULL) {
        store_result_set(result, WORKSPACE_STORE_ERR_NULL);
        return NULL;
    }

    /*
     * g_file_get_contents replaces the fopen/fseek/ftell/malloc/fread dance
     * this used to spell out, and the "a missing file is not an error"
     * contract is now one error-code comparison rather than an errno check.
     */
    if (!g_file_get_contents(path, &contents, &length, &error)) {
        if (g_error_matches(error, G_FILE_ERROR, G_FILE_ERROR_NOENT)) {
            g_clear_error(&error);
            store_result_set(result, WORKSPACE_STORE_OK);
            return calloc(1, 1);
        }
        g_clear_error(&error);
        store_result_set(result, WORKSPACE_STORE_ERR_READ);
        return NULL;
    }

    if (length > WORKSPACE_STORE_MAX_BYTES) {
        g_free(contents);
        store_result_set(result, WORKSPACE_STORE_ERR_TOO_LARGE);
        return NULL;
    }

    if (length_out != NULL) *length_out = (size_t)length;
    store_result_set(result, status);
    return contents;
}

/*
 * fsyncs the directory holding path so a completed rename survives a crash.
 * The directory is copied onto the stack rather than allocated, so this adds
 * no allocator to a module that deliberately uses one.
 */
static int sync_directory(const char *path) {
    char directory[PATH_MAX];
    const char *slash = strrchr(path, '/');
    size_t length;
    int descriptor;
    int synced;

    if (slash == NULL) {
        directory[0] = '.';
        length = 1;
    } else {
        length = (size_t)(slash - path);
        if (length == 0) length = 1; /* a path like "/file" lives in "/" */
    }
    if (length >= sizeof(directory)) return -1;
    memcpy(directory, path, length);
    directory[length] = '\0';

    descriptor = open(directory, O_RDONLY);
    if (descriptor < 0) return -1;
    synced = fsync(descriptor);
    close(descriptor);
    return synced;
}

workspace_store_result workspace_store_save(const char *path, const char *data,
                                            size_t length) {
    char *temporary = NULL;
    size_t path_length;
    FILE *file;

    if (path == NULL || data == NULL) return WORKSPACE_STORE_ERR_NULL;
    if (length > WORKSPACE_STORE_MAX_BYTES) return WORKSPACE_STORE_ERR_TOO_LARGE;

    path_length = strlen(path);
    temporary = malloc(path_length + 5);
    if (temporary == NULL) return WORKSPACE_STORE_ERR_OUT_OF_MEMORY;
    memcpy(temporary, path, path_length);
    memcpy(temporary + path_length, ".tmp", 5);

    file = fopen(temporary, "wb");
    if (file == NULL) {
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }
    if (length > 0 && fwrite(data, 1, length, file) != length) {
        fclose(file);
        remove(temporary);
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }
    if (fflush(file) != 0 || fsync(fileno(file)) != 0 || fclose(file) != 0) {
        remove(temporary);
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }
    if (rename(temporary, path) != 0) {
        remove(temporary);
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }

    /* The rename itself must reach the disk, or a crash can lose the new name. */
    if (sync_directory(path) != 0) {
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }

    free(temporary);
    return WORKSPACE_STORE_OK;
}

int workspace_store_is_object(const char *data, size_t length) {
    size_t start = 0;
    size_t end = length;

    if (data == NULL || length == 0) return 0;
    while (start < end && isspace((unsigned char)data[start]) != 0) start++;
    if (start >= end || data[start] != '{') return 0;
    while (end > start && isspace((unsigned char)data[end - 1]) != 0) end--;
    return end > start && data[end - 1] == '}';
}

char *workspace_store_decode_argument(const char *request,
                                      workspace_store_result *result) {
    json_result status;
    char *values[1] = {NULL};

    status = json_read_string_array(request, 1, values, NULL);
    if (status == JSON_ERR_NULL) {
        store_result_set(result, WORKSPACE_STORE_ERR_NULL);
        return NULL;
    }
    if (status == JSON_ERR_MEMORY) {
        store_result_set(result, WORKSPACE_STORE_ERR_OUT_OF_MEMORY);
        return NULL;
    }
    if (status != JSON_OK) {
        store_result_set(result, WORKSPACE_STORE_ERR_ARGUMENT);
        return NULL;
    }

    store_result_set(result, WORKSPACE_STORE_OK);
    return values[0];
}
