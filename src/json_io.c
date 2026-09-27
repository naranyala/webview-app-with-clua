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

/* --- reading general JSON ------------------------------------------------- */

/*
 * A recursive-descent parser over the same string rules read_string() already
 * enforces. Children are collected into a small growable buffer rather than
 * counted first, because a general document's shape is not known in advance and
 * the two-pass trick the array reader uses would need the whole grammar twice
 * for a tree of unknown depth.
 */

typedef struct {
    const char *cursor;
    json_result status;
    int depth;
} json_parser;

static json_value *parse_value(json_parser *parser);

static json_value *new_value(json_value_type type) {
    json_value *value = calloc(1, sizeof(*value));
    if (value != NULL) value->type = type;
    return value;
}

void json_value_free(json_value *value) {
    if (value == NULL) return;
    for (size_t index = 0; index < value->count; index++) {
        if (value->members != NULL) {
            g_free(value->members[index].name);
            json_value_free(value->members[index].value);
        } else {
            json_value_free(value->items[index]);
        }
    }
    g_free(value->members);
    g_free(value->items);
    g_free(value->text);
    g_free(value);
}

/* --- literals ------------------------------------------------------------- */

static json_value *parse_null(json_parser *parser) {
    if (strncmp(parser->cursor, "null", 4) != 0) {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    parser->cursor += 4;
    return new_value(JSON_VALUE_NULL);
}

static json_value *parse_true_or_false(json_parser *parser, int boolean) {
    const char *word = boolean ? "true" : "false";
    size_t length = boolean ? 4 : 5;
    json_value *value = NULL;
    if (strncmp(parser->cursor, word, length) != 0) {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    parser->cursor += length;
    value = new_value(JSON_VALUE_BOOL);
    if (value != NULL) value->boolean = boolean;
    return value;
}

static json_value *parse_number(json_parser *parser) {
    char *end = NULL;
    double number;
    json_value *value = NULL;

    /* strtod does the grammar; it also accepts forms JSON forbids (inf, nan),
       so the leading character is checked first and the span re-validated. */
    if (*parser->cursor != '-' && (*parser->cursor < '0' || *parser->cursor > '9')) {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    number = strtod(parser->cursor, &end);
    if (end == parser->cursor) {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    /* Reject a bare "1." or "1e": JSON requires a digit after each. */
    if (end[-1] == '.' || end[-1] == 'e' || end[-1] == 'E') {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    parser->cursor = end;
    value = new_value(JSON_VALUE_NUMBER);
    if (value != NULL) value->number = number;
    return value;
}

static json_value *parse_string(json_parser *parser) {
    const char *start = parser->cursor;
    size_t length = 0;
    json_value *value = NULL;

    if (*parser->cursor != '"') {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    /* Measure, allocate exactly, then decode: the same two-pass discipline as
       json_read_string_array(), so a long draft cannot overflow a fixed buffer. */
    if (read_string(&parser->cursor, NULL, &length) != JSON_OK) {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    value = new_value(JSON_VALUE_STRING);
    if (value == NULL) {
        parser->status = JSON_ERR_MEMORY;
        return NULL;
    }
    value->text = malloc(length + 1);
    if (value->text == NULL) {
        json_value_free(value);
        parser->status = JSON_ERR_MEMORY;
        return NULL;
    }
    /* Second pass, from the opening quote, into the buffer just sized. */
    {
        const char *cursor = start;
        if (read_string(&cursor, value->text, &length) != JSON_OK) {
            json_value_free(value);
            parser->status = JSON_ERR_MALFORMED;
            return NULL;
        }
        value->text[length] = '\0';
        parser->cursor = cursor;
    }
    return value;
}

/* --- containers ------------------------------------------------------------ */

/* Grows *items to hold at least one more child, doubling to keep this amortized. */
static int reserve_slot(json_value ***items, size_t *capacity) {
    if (*capacity == 0) {
        *items = calloc(8, sizeof(**items));
        if (*items == NULL) return 0;
        *capacity = 8;
        return 1;
    }
    if (*capacity > (size_t)-1 / 2 || *capacity * 2 > ((size_t)-1) / sizeof(**items)) {
        return 0;
    }
    {
        json_value **grown = realloc(*items, *capacity * 2 * sizeof(**items));
        if (grown == NULL) return 0;
        *items = grown;
        *capacity *= 2;
        return 1;
    }
}

static int reserve_member(json_member **members, size_t *capacity) {
    if (*capacity == 0) {
        *members = calloc(8, sizeof(**members));
        if (*members == NULL) return 0;
        *capacity = 8;
        return 1;
    }
    if (*capacity > (size_t)-1 / 2 || *capacity * 2 > ((size_t)-1) / sizeof(**members)) {
        return 0;
    }
    {
        json_member *grown = realloc(*members, *capacity * 2 * sizeof(**members));
        if (grown == NULL) return 0;
        *members = grown;
        *capacity *= 2;
        return 1;
    }
}

static json_value *parse_array(json_parser *parser) {
    json_value *array = new_value(JSON_VALUE_ARRAY);
    size_t capacity = 0;
    if (array == NULL) {
        parser->status = JSON_ERR_MEMORY;
        return NULL;
    }
    parser->cursor++; /* past '[' */
    skip_whitespace(&parser->cursor);
    if (*parser->cursor == ']') {
        parser->cursor++;
        return array;
    }
    for (;;) {
        json_value *child = parse_value(parser);
        if (child == NULL) {
            json_value_free(array);
            return NULL;
        }
        if (!reserve_slot(&array->items, &capacity)) {
            json_value_free(child);
            json_value_free(array);
            parser->status = JSON_ERR_MEMORY;
            return NULL;
        }
        array->items[array->count++] = child;
        skip_whitespace(&parser->cursor);
        if (*parser->cursor == ',') {
            parser->cursor++;
            skip_whitespace(&parser->cursor);
            continue;
        }
        if (*parser->cursor == ']') {
            parser->cursor++;
            return array;
        }
        json_value_free(array);
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
}

static json_value *parse_object(json_parser *parser) {
    json_value *object = new_value(JSON_VALUE_OBJECT);
    size_t capacity = 0;
    if (object == NULL) {
        parser->status = JSON_ERR_MEMORY;
        return NULL;
    }
    parser->cursor++; /* past '{' */
    skip_whitespace(&parser->cursor);
    if (*parser->cursor == '}') {
        parser->cursor++;
        return object;
    }
    for (;;) {
        json_value *key = parse_string(parser);
        json_value *child = NULL;
        if (key == NULL) {
            json_value_free(object);
            return NULL;
        }
        skip_whitespace(&parser->cursor);
        if (*parser->cursor != ':') {
            json_value_free(key);
            json_value_free(object);
            parser->status = JSON_ERR_MALFORMED;
            return NULL;
        }
        parser->cursor++;
        child = parse_value(parser);
        if (child == NULL) {
            json_value_free(key);
            json_value_free(object);
            return NULL;
        }
        if (!reserve_member(&object->members, &capacity)) {
            json_value_free(key);
            json_value_free(child);
            json_value_free(object);
            parser->status = JSON_ERR_MEMORY;
            return NULL;
        }
        /* parse_string owns the decoded key; the member takes it over. */
        object->members[object->count].name = key->text;
        key->text = NULL;
        json_value_free(key);
        object->members[object->count].value = child;
        object->count++;
        skip_whitespace(&parser->cursor);
        if (*parser->cursor == ',') {
            parser->cursor++;
            skip_whitespace(&parser->cursor);
            continue;
        }
        if (*parser->cursor == '}') {
            parser->cursor++;
            return object;
        }
        json_value_free(object);
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
}

static json_value *parse_value(json_parser *parser) {
    json_value *value = NULL;
    char lead;

    if (parser->depth >= JSON_MAX_DEPTH) {
        /* A stack overflow is a crash the webview can trigger; refuse instead. */
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    skip_whitespace(&parser->cursor);
    lead = *parser->cursor;
    if (lead == '\0') {
        parser->status = JSON_ERR_MALFORMED;
        return NULL;
    }
    parser->depth++;
    if (lead == '{') {
        value = parse_object(parser);
    } else if (lead == '[') {
        value = parse_array(parser);
    } else if (lead == '"') {
        value = parse_string(parser);
    } else if (lead == 't') {
        value = parse_true_or_false(parser, 1);
    } else if (lead == 'f') {
        value = parse_true_or_false(parser, 0);
    } else if (lead == 'n') {
        value = parse_null(parser);
    } else {
        value = parse_number(parser);
    }
    parser->depth--;
    return value;
}

json_value *json_parse(const char *text, json_result *result) {
    json_parser parser;
    json_value *root;

    if (result != NULL) *result = JSON_OK;
    if (text == NULL) {
        if (result != NULL) *result = JSON_ERR_NULL;
        return NULL;
    }
    parser.cursor = text;
    parser.status = JSON_OK;
    parser.depth = 0;

    root = parse_value(&parser);
    if (root == NULL) {
        if (result != NULL) *result = parser.status == JSON_OK ? JSON_ERR_MALFORMED : parser.status;
        return NULL;
    }
    /* Trailing content means a doubled or concatenated document: rejecting it is
       the difference between reading a document and reading its first prefix. */
    skip_whitespace(&parser.cursor);
    if (*parser.cursor != '\0') {
        json_value_free(root);
        if (result != NULL) *result = JSON_ERR_MALFORMED;
        return NULL;
    }
    return root;
}

/* --- accessors ------------------------------------------------------------- */

const json_value *json_object_get(const json_value *object, const char *name) {
    if (object == NULL || object->type != JSON_VALUE_OBJECT || name == NULL) return NULL;
    for (size_t index = 0; index < object->count; index++) {
        if (object->members[index].name != NULL &&
            strcmp(object->members[index].name, name) == 0) {
            return object->members[index].value;
        }
    }
    return NULL;
}

const char *json_string(const json_value *value, const char *fallback) {
    if (value == NULL || value->type != JSON_VALUE_STRING || value->text == NULL) return fallback;
    return value->text;
}

double json_number(const json_value *value, double fallback) {
    if (value == NULL || value->type != JSON_VALUE_NUMBER) return fallback;
    return value->number;
}

int json_bool(const json_value *value, int fallback) {
    if (value == NULL || value->type != JSON_VALUE_BOOL) return fallback;
    return value->boolean;
}

size_t json_count(const json_value *value) {
    if (value == NULL) return 0;
    if (value->type != JSON_VALUE_ARRAY && value->type != JSON_VALUE_OBJECT) return 0;
    return value->count;
}

const json_value *json_at(const json_value *array, size_t index) {
    if (array == NULL || array->type != JSON_VALUE_ARRAY || index >= array->count) return NULL;
    return array->items[index];
}
