#include "workspace_store.h"

#include <ctype.h>
#include <errno.h>
#include <stdio.h>
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

char *workspace_store_load(const char *path, size_t *length_out,
                           workspace_store_result *result) {
    workspace_store_result status = WORKSPACE_STORE_OK;
    char *buffer = NULL;
    long file_size = 0;
    size_t read_count = 0;
    FILE *file;

    if (length_out != NULL) *length_out = 0;

    if (path == NULL) {
        status = WORKSPACE_STORE_ERR_NULL;
        goto done;
    }

    file = fopen(path, "rb");
    if (file == NULL) {
        status = (errno == ENOENT) ? WORKSPACE_STORE_OK : WORKSPACE_STORE_ERR_READ;
        goto done;
    }

    if (fseek(file, 0, SEEK_END) != 0) {
        status = WORKSPACE_STORE_ERR_READ;
        fclose(file);
        goto done;
    }
    file_size = ftell(file);
    if (file_size < 0) {
        status = WORKSPACE_STORE_ERR_READ;
        fclose(file);
        goto done;
    }
    if ((unsigned long)file_size > WORKSPACE_STORE_MAX_BYTES) {
        status = WORKSPACE_STORE_ERR_TOO_LARGE;
        fclose(file);
        goto done;
    }
    rewind(file);

    buffer = malloc((size_t)file_size + 1);
    if (buffer == NULL) {
        status = WORKSPACE_STORE_ERR_OUT_OF_MEMORY;
        fclose(file);
        goto done;
    }

    read_count = fread(buffer, 1, (size_t)file_size, file);
    if (read_count != (size_t)file_size && ferror(file) != 0) {
        free(buffer);
        buffer = NULL;
        status = WORKSPACE_STORE_ERR_READ;
        fclose(file);
        goto done;
    }
    fclose(file);

    buffer[read_count] = '\0';
    if (length_out != NULL) *length_out = read_count;

done:
    if (status == WORKSPACE_STORE_OK && buffer == NULL) {
        buffer = malloc(1);
        if (buffer == NULL) {
            status = WORKSPACE_STORE_ERR_OUT_OF_MEMORY;
        } else {
            buffer[0] = '\0';
        }
    }
    store_result_set(result, status);
    if (status != WORKSPACE_STORE_OK) {
        free(buffer);
        return NULL;
    }
    return buffer;
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
    if (fflush(file) != 0 || fclose(file) != 0) {
        remove(temporary);
        free(temporary);
        return WORKSPACE_STORE_ERR_WRITE;
    }
    if (rename(temporary, path) != 0) {
        remove(temporary);
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

static void skip_whitespace(const char **cursor_ref) {
    const char *cursor = *cursor_ref;
    while (*cursor != '\0' && isspace((unsigned char)*cursor) != 0) cursor++;
    *cursor_ref = cursor;
}

static int hex_value(char character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

static int read_hex4(const char *cursor, unsigned long *value_out) {
    unsigned long value = 0;
    for (size_t index = 0; index < 4; index++) {
        int digit = hex_value(cursor[index]);
        if (digit < 0 || cursor[index] == '\0') return 0;
        value = (value << 4) | (unsigned long)digit;
    }
    *value_out = value;
    return 1;
}

static size_t append_utf8(char *output, size_t used, unsigned long code_point) {
    if (code_point <= 0x7F) {
        output[used] = (char)code_point;
        return used + 1;
    }
    if (code_point <= 0x7FF) {
        output[used] = (char)(0xC0 | (code_point >> 6));
        output[used + 1] = (char)(0x80 | (code_point & 0x3F));
        return used + 2;
    }
    if (code_point <= 0xFFFF) {
        output[used] = (char)(0xE0 | (code_point >> 12));
        output[used + 1] = (char)(0x80 | ((code_point >> 6) & 0x3F));
        output[used + 2] = (char)(0x80 | (code_point & 0x3F));
        return used + 3;
    }
    output[used] = (char)(0xF0 | (code_point >> 18));
    output[used + 1] = (char)(0x80 | ((code_point >> 12) & 0x3F));
    output[used + 2] = (char)(0x80 | ((code_point >> 6) & 0x3F));
    output[used + 3] = (char)(0x80 | (code_point & 0x3F));
    return used + 4;
}

static int decode_string(const char **cursor_ref, char *output,
                         size_t *used_ref, workspace_store_result *status) {
    const char *cursor = *cursor_ref;
    size_t used = *used_ref;

    cursor++;
    while (*cursor != '\0' && *cursor != '"') {
        if (*cursor != '\\') {
            output[used++] = *cursor++;
            continue;
        }
        cursor++;
        switch (*cursor) {
            case '"':
            case '\\':
            case '/':
                output[used++] = *cursor++;
                break;
            case 'b':
                output[used++] = '\b';
                cursor++;
                break;
            case 'f':
                output[used++] = '\f';
                cursor++;
                break;
            case 'n':
                output[used++] = '\n';
                cursor++;
                break;
            case 'r':
                output[used++] = '\r';
                cursor++;
                break;
            case 't':
                output[used++] = '\t';
                cursor++;
                break;
            case 'u': {
                unsigned long code_point = 0;
                if (!read_hex4(cursor + 1, &code_point)) {
                    *status = WORKSPACE_STORE_ERR_ARGUMENT;
                    return 0;
                }
                cursor += 5;
                if (code_point >= 0xD800 && code_point <= 0xDBFF &&
                    cursor[0] == '\\' && cursor[1] == 'u') {
                    unsigned long low = 0;
                    if (read_hex4(cursor + 2, &low) && low >= 0xDC00 && low <= 0xDFFF) {
                        code_point = 0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00);
                        cursor += 6;
                    }
                }
                used = append_utf8(output, used, code_point);
                break;
            }
            default:
                *status = WORKSPACE_STORE_ERR_ARGUMENT;
                return 0;
        }
    }
    if (*cursor != '"') {
        *status = WORKSPACE_STORE_ERR_ARGUMENT;
        return 0;
    }
    cursor++;
    *cursor_ref = cursor;
    *used_ref = used;
    return 1;
}

char *workspace_store_decode_argument(const char *request,
                                      workspace_store_result *result) {
    workspace_store_result status = WORKSPACE_STORE_OK;
    const char *cursor = request;
    char *output = NULL;
    size_t capacity;
    size_t used = 0;

    if (request == NULL) {
        status = WORKSPACE_STORE_ERR_NULL;
        goto done;
    }

    capacity = strlen(request) + 1;
    output = malloc(capacity);
    if (output == NULL) {
        status = WORKSPACE_STORE_ERR_OUT_OF_MEMORY;
        goto done;
    }

    skip_whitespace(&cursor);
    if (*cursor != '[') {
        status = WORKSPACE_STORE_ERR_ARGUMENT;
        goto done;
    }
    cursor++;
    skip_whitespace(&cursor);
    if (*cursor != '"') {
        status = WORKSPACE_STORE_ERR_ARGUMENT;
        goto done;
    }
    if (!decode_string(&cursor, output, &used, &status)) goto done;

    skip_whitespace(&cursor);
    if (*cursor != ']') {
        status = WORKSPACE_STORE_ERR_ARGUMENT;
        goto done;
    }
    cursor++;
    skip_whitespace(&cursor);
    if (*cursor != '\0') {
        status = WORKSPACE_STORE_ERR_ARGUMENT;
        goto done;
    }

    output[used] = '\0';

done:
    store_result_set(result, status);
    if (status != WORKSPACE_STORE_OK) {
        free(output);
        return NULL;
    }
    return output;
}
