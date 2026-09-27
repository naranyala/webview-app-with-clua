/*
 * The host's single JSON codec. See include/json_io.h for the contract.
 *
 * The reader measures before it allocates: a first pass validates the grammar
 * and records each decoded length, the caller allocates exactly that, and a
 * second pass fills the buffers. That costs one extra walk over the request
 * and buys exact allocations — a saveTextFile payload no longer reserves the
 * whole request twice — and it makes an overflow impossible by construction
 * rather than by a bounds check on every byte.
 */

#include "json_io.h"

#include <stdlib.h>
#include <string.h>

/* --- writing -------------------------------------------------------------- */

void json_append_string(GString *output, const char *value) {
    g_string_append_c(output, '"');
    for (const unsigned char *cursor = (const unsigned char *)(value != NULL ? value : ""); *cursor != '\0'; cursor++) {
        switch (*cursor) {
            case '"': g_string_append(output, "\\\""); break;
            case '\\': g_string_append(output, "\\\\"); break;
            case '\b': g_string_append(output, "\\b"); break;
            case '\f': g_string_append(output, "\\f"); break;
            case '\n': g_string_append(output, "\\n"); break;
            case '\r': g_string_append(output, "\\r"); break;
            case '\t': g_string_append(output, "\\t"); break;
            default:
                if (*cursor < 0x20) g_string_append_printf(output, "\\u%04x", *cursor);
                else g_string_append_c(output, (char)*cursor);
        }
    }
    g_string_append_c(output, '"');
}

void json_append_error(GString *output, const char *code, const char *message) {
    g_string_append(output, "{\"error\":{\"code\":");
    json_append_string(output, code);
    g_string_append(output, ",\"message\":");
    json_append_string(output, message);
    g_string_append(output, "}}");
}

const char *json_strerror(json_result result) {
    switch (result) {
        case JSON_OK: return "The request was decoded.";
        case JSON_ERR_NULL: return "No request data was received.";
        case JSON_ERR_MALFORMED: return "The request must be a JSON array of strings.";
        case JSON_ERR_CONTROL: return "The request contains a raw control character.";
        case JSON_ERR_ESCAPE: return "The request contains an invalid escape sequence.";
        case JSON_ERR_MEMORY: return "The request could not be decoded into memory.";
        default: return "The request could not be decoded.";
    }
}

/* --- reading -------------------------------------------------------------- */

static void skip_whitespace(const char **cursor_ref) {
    const char *cursor = *cursor_ref;
    while (*cursor == ' ' || *cursor == '\t' || *cursor == '\n' || *cursor == '\r') {
        cursor++;
    }
    *cursor_ref = cursor;
}

static int read_hex4(const char *cursor, unsigned long *out) {
    unsigned long value = 0;
    for (int index = 0; index < 4; index++) {
        char digit = cursor[index];
        if (digit == '\0') return 0;
        value <<= 4;
        if (digit >= '0' && digit <= '9') value += (unsigned long)(digit - '0');
        else if (digit >= 'a' && digit <= 'f') value += (unsigned long)(digit - 'a' + 10);
        else if (digit >= 'A' && digit <= 'F') value += (unsigned long)(digit - 'A' + 10);
        else return 0;
    }
    *out = value;
    return 1;
}

static size_t utf8_width(unsigned long code_point) {
    if (code_point <= 0x7F) return 1;
    if (code_point <= 0x7FF) return 2;
    if (code_point <= 0xFFFF) return 3;
    return 4;
}

static size_t write_utf8(char *output, size_t used, unsigned long code_point) {
    if (code_point <= 0x7F) {
        output[used++] = (char)code_point;
    } else if (code_point <= 0x7FF) {
        output[used++] = (char)(0xC0 | (code_point >> 6));
        output[used++] = (char)(0x80 | (code_point & 0x3F));
    } else if (code_point <= 0xFFFF) {
        output[used++] = (char)(0xE0 | (code_point >> 12));
        output[used++] = (char)(0x80 | ((code_point >> 6) & 0x3F));
        output[used++] = (char)(0x80 | (code_point & 0x3F));
    } else {
        output[used++] = (char)(0xF0 | (code_point >> 18));
        output[used++] = (char)(0x80 | ((code_point >> 12) & 0x3F));
        output[used++] = (char)(0x80 | ((code_point >> 6) & 0x3F));
        output[used++] = (char)(0x80 | (code_point & 0x3F));
    }
    return used;
}

/*
 * Consumes one JSON string. With output NULL it only measures; with output set
 * it also writes. The cursor must point at the opening quote on entry and at
 * the first character after the closing quote on return.
 */
static json_result read_string(const char **cursor_ref, char *output, size_t *used_ref) {
    const char *cursor = *cursor_ref;
    size_t used = 0;

    cursor++; /* opening quote */
    for (;;) {
        unsigned char character = (unsigned char)*cursor;
        if (character == '\0') return JSON_ERR_MALFORMED;
        if (character == '"') {
            cursor++;
            break;
        }
        if (character < 0x20) return JSON_ERR_CONTROL;
        if (character != '\\') {
            if (output != NULL) output[used] = (char)character;
            used++;
            cursor++;
            continue;
        }

        cursor++;
        switch (*cursor) {
            case '"':
            case '\\':
            case '/':
                if (output != NULL) output[used] = *cursor;
                used++;
                cursor++;
                break;
            case 'b': if (output != NULL) output[used] = '\b'; used++; cursor++; break;
            case 'f': if (output != NULL) output[used] = '\f'; used++; cursor++; break;
            case 'n': if (output != NULL) output[used] = '\n'; used++; cursor++; break;
            case 'r': if (output != NULL) output[used] = '\r'; used++; cursor++; break;
            case 't': if (output != NULL) output[used] = '\t'; used++; cursor++; break;
            case 'u': {
                unsigned long code_point = 0;
                if (!read_hex4(cursor + 1, &code_point)) return JSON_ERR_ESCAPE;
                cursor += 5;
                if (code_point >= 0xD800 && code_point <= 0xDBFF &&
                    cursor[0] == '\\' && cursor[1] == 'u') {
                    unsigned long low = 0;
                    if (read_hex4(cursor + 2, &low) && low >= 0xDC00 && low <= 0xDFFF) {
                        code_point = 0x10000 + ((code_point - 0xD800) << 10) + (low - 0xDC00);
                        cursor += 6;
                    }
                }
                if (output != NULL) used = write_utf8(output, used, code_point);
                else used += utf8_width(code_point);
                break;
            }
            default:
                return JSON_ERR_ESCAPE;
        }
    }

    if (output != NULL) output[used] = '\0';
    *cursor_ref = cursor;
    *used_ref = used;
    return JSON_OK;
}

json_result json_read_string_array(const char *request, size_t count,
                                   char **values, size_t *lengths) {
    const char *cursor = request;
    json_result status = JSON_OK;
    size_t stack_lengths[4];
    size_t *measured = lengths;
    int owns_measured = 0;
    size_t index;

    if (values == NULL) return JSON_ERR_NULL;
    for (index = 0; index < count; index++) {
        values[index] = NULL;
        if (lengths != NULL) lengths[index] = 0;
    }
    if (request == NULL) return JSON_ERR_NULL;
    if (count == 0) return JSON_OK;

    /* The measured lengths drive the allocations, so they are always kept. */
    if (measured == NULL) {
        if (count <= sizeof(stack_lengths) / sizeof(stack_lengths[0])) {
            measured = stack_lengths;
        } else {
            measured = malloc(count * sizeof(*measured));
            if (measured == NULL) return JSON_ERR_MEMORY;
            owns_measured = 1;
        }
    }

    skip_whitespace(&cursor);
    if (*cursor != '[') {
        status = JSON_ERR_MALFORMED;
        goto done;
    }
    cursor++;

    /* First pass: validate the whole request and record decoded lengths. */
    for (index = 0; index < count; index++) {
        size_t length = 0;
        skip_whitespace(&cursor);
        if (*cursor != '"') {
            status = JSON_ERR_MALFORMED;
            goto done;
        }
        status = read_string(&cursor, NULL, &length);
        if (status != JSON_OK) goto done;
        measured[index] = length;
        if (lengths != NULL) lengths[index] = length;
        skip_whitespace(&cursor);
        if (index + 1 < count) {
            if (*cursor != ',') {
                status = JSON_ERR_MALFORMED;
                goto done;
            }
            cursor++;
        }
    }
    skip_whitespace(&cursor);
    if (*cursor != ']') {
        status = JSON_ERR_MALFORMED;
        goto done;
    }
    cursor++;
    skip_whitespace(&cursor);
    if (*cursor != '\0') {
        status = JSON_ERR_MALFORMED;
        goto done;
    }

    /* Second pass: allocate exactly what the first pass measured. */
    cursor = request;
    skip_whitespace(&cursor);
    cursor++; /* past '[' */
    for (index = 0; index < count; index++) {
        size_t length = 0;
        values[index] = malloc(measured[index] + 1);
        if (values[index] == NULL) {
            status = JSON_ERR_MEMORY;
            goto done;
        }
        skip_whitespace(&cursor);
        status = read_string(&cursor, values[index], &length);
        if (status != JSON_OK) goto done;
        values[index][length] = '\0';
        if (index + 1 < count) {
            skip_whitespace(&cursor);
            cursor++; /* past ',' */
        }
    }
    status = JSON_OK;

done:
    if (status != JSON_OK) json_free_values(values, count);
    if (owns_measured) free(measured);
    return status;
}

void json_free_values(char **values, size_t count) {
    if (values == NULL) return;
    for (size_t index = 0; index < count; index++) {
        free(values[index]);
        values[index] = NULL;
    }
}
