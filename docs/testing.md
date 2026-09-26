# Testing guide

Testing is split by boundary so a failure points to the smallest relevant
layer.

## Test layers

### C engine tests

[`tests/test_metrics.c`](../tests/test_metrics.c) covers empty summaries, null
arguments, safe lifecycle helpers, finite-value validation, positive and
negative values, singleton and zero-variance data, min/max, sum, mean, stable
variance for large close values, and arithmetic overflow rejection with state
preservation.

Run:

```sh
make core-test
```

### Bridge parser tests

[`tests/test_bridge.c`](../tests/test_bridge.c) tests the serialized WebView
request independently of the GUI. It covers valid syntax, whitespace, signs,
exponents, malformed arrays, trailing content, non-finite values, null
arguments, and response-buffer boundaries.

Run:

```sh
make bridge-test
```

### Workspace store tests

[`tests/test_workspace_store.c`](../tests/test_workspace_store.c) covers the
file-backed workspace used for restart persistence: a missing file reads as
empty state, save/load round trips preserve UTF-8 and escapes, oversized
payloads are rejected, writes are atomic, JSON object detection guards the
response shape, and binding argument decoding handles escapes, Unicode
(including surrogate pairs), and malformed request lists.

Run:

```sh
make workspace-test
```

The sanitized target rebuilds it with AddressSanitizer and
UndefinedBehaviorSanitizer as well.

### Lua integration tests

[`tests/test_core.lua`](../tests/test_core.lua) verifies that the Lua wrapper
can create engines, add values, summarize, reset, chain calls, and surface
invalid values as Lua errors.

Run:

```sh
make lua-test
```

### Sanitizer tests

The sanitizer target rebuilds the C and bridge tests with AddressSanitizer and
UndefinedBehaviorSanitizer:

```sh
make sanitized-test
```

LeakSanitizer is disabled by the Makefile target because it may not work under
traced or containerized execution. Run the generated executable directly with
leak detection enabled when the environment supports it.

### Frontend checks

The frontend has pure behavior tests for input parsing, bridge error decoding,
number formatting, and result rendering. They run without a browser or WebView:

```sh
cd frontend-vue
npm test
npm run check
npm run build
```

The native bridge itself remains covered by `make bridge-test`.

## Full local verification

With Lua installed:

```sh
lua build.lua test
```

For the complete desktop path, also run:

```sh
lua build.lua desktop
```

Then enter valid, invalid, empty, and very large values in the UI.

## Test design principles

- Test public contracts, not private implementation details.
- Check that rejected input leaves engine state unchanged.
- Include boundary values and malformed protocol input.
- Keep C and bridge tests runnable without a GUI.
- Treat the frontend-to-native smoke path as separate from unit tests.
