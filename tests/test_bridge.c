#include "webview_bridge.h"

#include <assert.h>
#include <string.h>

static void assert_contains(const char *text, const char *needle) {
    assert(strstr(text, needle) != NULL);
}

int main(void) {
    char response[512];
    char tiny_response[4] = {'x', 'x', 'x', 'x'};

    assert(summarize_request(" [[2, 4, 6]] ", response, sizeof(response)) == 1);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"mean\":4");
    assert_contains(response, "\"variance\":2.6666666666666665");

    assert(summarize_request("[ [ +1.5, -2.5, 3e2 ] ]", response, sizeof(response)) == 1);
    assert_contains(response, "\"count\":3");
    assert_contains(response, "\"sum\":299");
    assert_contains(response, "\"min\":-2.5");
    assert_contains(response, "\"max\":300");

    assert(summarize_request("[\t[1e-3, 2E+2]\n]", response, sizeof(response)) == 1);
    assert_contains(response, "\"count\":2");

    assert(summarize_request("[[]]", response, sizeof(response)) == 0);
    assert_contains(response, "\"code\":\"EMPTY_INPUT\"");
    assert_contains(response, "non-empty");
    assert(summarize_request("", response, sizeof(response)) == 0);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");
    assert(summarize_request("[]", response, sizeof(response)) == 0);
    assert(summarize_request("[1, 2]", response, sizeof(response)) == 0);
    assert(summarize_request("[[1, nope]]", response, sizeof(response)) == 0);
    assert_contains(response, "\"code\":\"INVALID_REQUEST\"");
    assert(summarize_request("[[1, 2], [3]]", response, sizeof(response)) == 0);
    assert(summarize_request("[[1, 2,]]", response, sizeof(response)) == 0);
    assert(summarize_request("[[1 2]]", response, sizeof(response)) == 0);
    assert(summarize_request("[[1, 2]] trailing", response, sizeof(response)) == 0);
    assert(summarize_request("[[nan]]", response, sizeof(response)) == 0);
    assert_contains(response, "\"code\":\"INVALID_VALUE\"");
    assert(summarize_request("[[inf]]", response, sizeof(response)) == 0);
    assert_contains(response, "\"code\":\"INVALID_VALUE\"");
    assert(summarize_request("[[1e309]]", response, sizeof(response)) == 0);
    assert(summarize_request("[[null]]", response, sizeof(response)) == 0);
    assert(summarize_request("[[true]]", response, sizeof(response)) == 0);
    assert(summarize_request(NULL, response, sizeof(response)) == 0);
    assert(summarize_request("[[1]]", NULL, sizeof(response)) == 0);
    assert(summarize_request("[[1]]", response, 0) == 0);
    assert(summarize_request("[[1, 2, 3]]", tiny_response, sizeof(tiny_response)) == 1);
    assert(tiny_response[sizeof(tiny_response) - 1] == '\0');
    assert(summarize_request("[[1]]", tiny_response, 1) == 1);
    assert(tiny_response[0] == '\0');
    return 0;
}
