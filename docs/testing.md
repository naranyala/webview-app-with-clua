# Testing guide

Testing is split by boundary so a failure points to the smallest relevant
layer.

## Test layers

### C engine tests

[`tests/test_metrics.c`](../tests/test_metrics.c) covers empty summaries, null
arguments, safe lifecycle helpers, finite-value validation, positive and
negative values, singleton and zero-variance data, min/max, sum, mean, stable
variance for large close values, arithmetic overflow rejection with state
preservation, reference mean/variance for a known data set, and the guarantee
that a rejected non-finite value leaves the running aggregate untouched.

Run:

```sh
make core-test
```

### Bridge parser tests

[`tests/test_bridge.c`](../tests/test_bridge.c) tests the serialized WebView
request independently of the GUI. It covers valid syntax, whitespace (including
a whitespace-only inner array), signs, exponents, malformed arrays, trailing
content, non-finite values, null arguments, the exact shape of the success
reply, and response-buffer boundaries down to the byte that holds the
terminator.

Run:

```sh
make bridge-test
```

### Workspace store tests

[`tests/test_workspace_store.c`](../tests/test_workspace_store.c) covers the
file-backed workspace used for restart persistence: a missing file reads as
empty state, save/load round trips preserve UTF-8 and escapes, oversized
payloads are rejected at both ends of the size cap, writes into a missing
directory fail cleanly, a directory path reports a read error, writes are
atomic, JSON object detection guards the response shape, and binding argument
decoding handles escapes, Unicode (including surrogate pairs), and malformed
request lists.

Run:

```sh
make workspace-test
```

### Host plumbing tests

[`tests/test_app_support.c`](../tests/test_app_support.c) covers the plumbing
shared by every desktop binding: percent-encoded `file://` URLs (spaces, UTF-8,
oversized buffers, null inputs), the shared JSON string escaping, the
`{"error":{code,message}}` reply the frontend unwraps, and picker dispatch
including the failure path that rejects the request itself. The webview calls
are recorded by stubs declared in
[`tests/stubs/webview/webview.h`](../tests/stubs/webview/webview.h), so no GUI
is involved; GTK is linked only because the path chooser shares the file.

Run:

```sh
make app-support-test
```

### PDF table-of-contents tests

[`tests/test_pdf_toc.c`](../tests/test_pdf_toc.c) generates fixture PDFs at
runtime, runs the real `pdftotext`, and checks heading extraction (levels and
pages), the "no headings" error, the per-document cache round trip including
fingerprint and format-marker mismatches, and the JSON reply the TOC Manager
parses. The XDG data directory is redirected into `build/pdf-toc-test`, so the
suite never writes to the real user home. It requires `pdftotext` on `PATH`.

Run:

```sh
make pdf-toc-test
```

The sanitized target rebuilds all five C test binaries with
AddressSanitizer and UndefinedBehaviorSanitizer.

### Lua integration tests

[`tests/test_core.lua`](../tests/test_core.lua) verifies that the Lua wrapper
can create engines, add values, summarize, reset, chain calls, and surface
invalid values as Lua errors.

Run:

```sh
make lua-test
```

### Sanitizer tests

The sanitizer target rebuilds every C test binary with AddressSanitizer and
UndefinedBehaviorSanitizer:

```sh
make sanitized-test
```

LeakSanitizer is disabled by the Makefile target because it may not work under
traced or containerized execution. Run the generated executable directly with
leak detection enabled when the environment supports it.

### Frontend checks

The frontend has pure behavior tests for input parsing, bridge error decoding,
number formatting, and result rendering, plus one file per session module
(`native-bridge`, `workspace-report`, `app-shell`, `editor-session`,
`pdf-session`, `image-session`, `toc-outline`) covering the state those modules
own: native call decoding, persistence reports, view cleanup, outline sync,
page navigation and scroll math, image grouping and the lightbox, and heading
import. Static contract tests cover the template, the stylesheet, the build
config, and the native host; `template-bindings.test.js` compiles `App.vue`
with Vue's compiler and fails when the template references a name the script
setup does not bind. They run without a browser or WebView:

```sh
cd frontend-vue
npm test
npm run check
npm run build
```

The native bridge itself remains covered by `make bridge-test`.

## Full local verification

Every C test plus the Lua binding test:

```sh
make test
make sanitized-test
```

With Lua installed, the same path (plus the frontend checks and build):

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
