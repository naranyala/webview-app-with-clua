/*
 * Unit tests for summarize_request(): the [[number, ...]] happy path, each
 * malformed-request branch, and the shape of the {"error":...} replies the
 * frontend relies on.
 */

#include "webview_bridge.h"

#include <assert.h>
#include <string.h>

static void assert_contains(const char *text, const char *needle) {
    assert(strstr(text, needle) != NULL);
}

int main(void) {
    char response[512];
    char tiny_response[4] = {'x', 'x', 'x', 'x'};
    bridge_error err;

    /* bridge_strerror should return valid strings for all error codes */
    assert(bridge_strerror(BRIDGE_OK) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_NULL_RESPONSE) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_BUFFER_TOO_SMALL) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_NULL_REQUEST) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_OUT_OF_MEMORY) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_MALFORMED_REQUEST) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_EMPTY_INPUT) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_INVALID_VALUE) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_TRAILING_DATA) != NULL);
    assert(bridge_strerror(BRIDGE_ERR_ENGINE_FAILED) != NULL);

    /* Successful requests */
    err = summarize_request(" [[2, 4, 6]] ", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"mean\":4");
    assert_contains(response, "\"variance\":2.6666666666666665");

    err = summarize_request("[ [ +1.5, -2.5, 3e2 ] ]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"sum\":299");
    assert_contains(response, "\"min\":-2.5");
    assert_contains(response, "\"max\":300");

    err = summarize_request("[\t[1e-3, 2E+2]\n]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":2");

    /* Newlines as separators between numbers */
    err = summarize_request("[[1\n2\n3]]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"mean\":2");

    /* Mixed commas and newlines */
    err = summarize_request("[[1, 2\n3, 4\n5]]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":5");

    /* Single value */
    err = summarize_request("[[42]]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":1");
    assert_contains(response, "\"mean\":42");

    /* Negative values */
    err = summarize_request("[[-1, -2, -3]]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"min\":-3");
    assert_contains(response, "\"max\":-1");

    /* A whitespace-only inner array is still empty input. */
    err = summarize_request("[ [ ] ]", response, sizeof(response));
    assert(err == BRIDGE_ERR_EMPTY_INPUT);
    assert_contains(response, "\"code\":\"EMPTY_INPUT\"");

    /* The success reply is one JSON object carrying every summary field. */
    err = summarize_request("[[1]]", response, sizeof(response));
    assert(err == BRIDGE_OK);
    assert(response[0] == '{');
    assert(response[strlen(response) - 1] == '}');
    {
        const char *fields[] = {
            "\"count\":", "\"sum\":", "\"min\":", "\"max\":", "\"mean\":", "\"variance\":",
        };
        for (size_t index = 0; index < sizeof(fields) / sizeof(fields[0]); index++) {
            assert_contains(response, fields[index]);
        }
    }

    /* The reply needs room for its terminator: exact fit passes, one short fails. */
    {
        size_t needed = strlen(response);
        char exact_response[512];
        assert(needed + 1 <= sizeof(exact_response));
        err = summarize_request("[[1]]", exact_response, needed + 1);
        assert(err == BRIDGE_OK);
        assert(strcmp(exact_response, response) == 0);
        err = summarize_request("[[1]]", exact_response, needed);
        assert(err == BRIDGE_ERR_BUFFER_TOO_SMALL);
        assert(exact_response[0] == '\0');
    }

    /* Empty inner array */
    err = summarize_request("[[]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_EMPTY_INPUT);
    assert_contains(response, "\"code\":\"EMPTY_INPUT\"");
    assert_contains(response, "at least one");

    /* Empty string */
    err = summarize_request("", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* Missing inner array brackets */
    err = summarize_request("[]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* Wrong nesting: single array instead of double */
    err = summarize_request("[1, 2]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* Non-numeric value */
    err = summarize_request("[[1, nope]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* Multiple inner arrays (extra content after inner close) */
    err = summarize_request("[[1, 2], [3]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* Trailing comma */
    err = summarize_request("[[1, 2,]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);

    /* Missing comma */
    err = summarize_request("[[1 2]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);

    /* Trailing data */
    err = summarize_request("[[1, 2]] trailing", response, sizeof(response));
    assert(err == BRIDGE_ERR_TRAILING_DATA);

    /* NaN value */
    err = summarize_request("[[nan]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_INVALID_VALUE);
    assert_contains(response, "\"code\":\"INVALID_VALUE\"");

    /* Infinity value */
    err = summarize_request("[[inf]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_INVALID_VALUE);
    assert_contains(response, "\"code\":\"INVALID_VALUE\"");

    /* Overflow value */
    err = summarize_request("[[1e309]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_INVALID_VALUE);

    /* JSON null (parsed as non-numeric) */
    err = summarize_request("[[null]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);

    /* JSON boolean (parsed as non-numeric) */
    err = summarize_request("[[true]]", response, sizeof(response));
    assert(err == BRIDGE_ERR_MALFORMED_REQUEST);

    /* NULL request */
    err = summarize_request(NULL, response, sizeof(response));
    assert(err == BRIDGE_ERR_NULL_REQUEST);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");

    /* NULL response buffer */
    err = summarize_request("[[1]]", NULL, sizeof(response));
    assert(err == BRIDGE_ERR_NULL_RESPONSE);

    /* Zero-size response buffer */
    err = summarize_request("[[1]]", response, 0);
    assert(err == BRIDGE_ERR_NULL_RESPONSE);

    /* Response buffer too small */
    err = summarize_request("[[1, 2, 3]]", tiny_response, sizeof(tiny_response));
    assert(err == BRIDGE_ERR_BUFFER_TOO_SMALL);
    assert(tiny_response[0] == '\0');

    /* Response buffer of exactly 1 byte */
    err = summarize_request("[[1]]", tiny_response, 1);
    assert(err == BRIDGE_ERR_BUFFER_TOO_SMALL);
    assert(tiny_response[0] == '\0');

    return 0;
}
