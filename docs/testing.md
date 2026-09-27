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

### Combined outline PDF tests

[`tests/test_outline_pdf.c`](../tests/test_outline_pdf.c) drives the
`chooseOutlineDirectory` / `renderOutlinePdf` bindings with the webview calls
replaced by recording stubs, so no GUI is involved. It covers the suggested-name
sanitizer (traversal, absolute paths, backslashes, reserved characters, dots
only, an over-long name), the refusal to write before a folder has been chosen,
the rejection of malformed and non-object outlines, level clamping, items with
no title, pagination of a long document, and that a word too wide for the
measure is split rather than dropped.

Cairo is linked for real, not mocked: "is this actually a PDF" and "does the page
count go up" cannot be answered honestly against a fake surface. Every case
checks the `%PDF-` header of the file cairo wrote. The suite needs cairo and
glib, which `make check-cairo` verifies.

Run:

```sh
make outline-pdf-test
```

### Text transfer tests

[`tests/test_text_transfer.c`](../tests/test_text_transfer.c) covers the
`openTextFile` / `saveTextFile` plumbing without a GUI: the save argument
decoder (escapes, surrogate pairs, whitespace, malformed and oversized
requests), the suggested-name sanitizer (path stripping, reserved characters,
fallbacks, UTF-8-safe caps), and the binding-level validation that rejects a
bad request before any dialog opens while a good one dispatches with its
payload attached. The webview calls are recorded by the same stubs as the
host plumbing tests.

Run:

```sh
make text-transfer-test
```

### JSON codec tests

[`tests/test_json_io.c`](../tests/test_json_io.c) covers the host's single
JSON codec: the writer (escaping, error documents, no size limit) and the
reader (escapes, `\uXXXX` with surrogate pairs, exact allocations, raw control
bytes rejected, and a table of malformed requests). Every binding decodes
through it, so this is where the shared grammar is pinned.

Run:

```sh
make json-io-test
```

### Smoke verdict tests

[`tests/test_smoke.c`](../tests/test_smoke.c) covers the smoke-run plumbing:
`METRICS_SMOKE` and `XDG_DATA_HOME` detection (including `0` and empty values),
the read-only and writable init markers, the strict verdict decoder (valid
flags, whitespace, and a table of malformed requests), and the `smokeVerdict`
binding itself (ack, recorded exit code, loop termination, and the paths that
must *not* terminate).

Run:

```sh
make smoke-unit-test
```

The sanitized target rebuilds all seven C test binaries with
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

The frontend has one file per session module (`native-bridge`, `file-io`, `workspace-persistence`,
`workspace-report`, `app-shell`, `editor-session`, `pdf-session`,
`image-session`, `toc-outline`) covering the state those modules own: native
call decoding and argument forwarding, system-picker transfers with their
browser fallbacks and one shared outcome pipeline, the persistence engine
(snapshot, write order, debounce, hydration), persistence reports, view cleanup, outline sync, page
navigation and scroll math, image grouping and the lightbox, heading
import, outline editing, and outline/draft import-export. Static contract
tests cover the template, the stylesheet,
the build config, and the native host; `template-bindings.test.js` compiles
`App.vue`
with Vue's compiler and fails when the template references a name the script
setup does not bind. They run without a browser or WebView:

```sh
cd frontend-vue
npm test
npm run check
npm run build
```

The native bridge itself remains covered by `make bridge-test`.

## Desktop smoke test

The unit tests prove each piece; the smoke test proves the wiring. It builds
the frontend and the desktop host, launches the real application in a real
graphical session once per render mode (`file://` URL and inline `set_html`),
and lets the frontend check the real DOM and the real bindings:

- the shell rendered (root shell, all four tool panes, the editor gate, four
  menu cards),
- `summarize` with representative values returns a summary, and bad input
  returns the shared error shape,
- `loadWorkspace` answers `{ok, workspace}`,
- and, when the run is isolated, a `saveWorkspace` probe survives a reload.

The frontend sends one verdict to the `smokeVerdict` binding, which prints a
single `SMOKE VERDICT` line and becomes the process exit code — so a green run
is the app's own answer, not a log grep. `METRICS_SMOKE=1` is what activates
all of this; without it nothing is bound and the page is untouched.

```sh
make smoke-test        # or: lua build.lua smoke
```

The run needs `DISPLAY` or `WAYLAND_DISPLAY` and redirects `XDG_DATA_HOME`
into a temporary directory, so it never reads or rewrites a real workspace.
`SMOKE_SKIP_BUILD=1` reuses the existing artifacts and `SMOKE_TIMEOUT` (60s
by default) bounds each mode; a mode that never reports fails on the timeout.
Logs land in `build/smoke/`. The checks themselves are unit tested in
[`tests/smoke.test.js`](../frontend-vue/tests/smoke.test.js) with stub
bindings, and the host half in `tests/test_smoke.c`.

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

Then enter valid, invalid, empty, and very large values in the UI, and run the
GUI smoke test on a machine with a graphical session:

```sh
make smoke-test
```

## Test design principles

- Test public contracts, not private implementation details.
- Check that rejected input leaves engine state unchanged.
- Include boundary values and malformed protocol input.
- Keep C and bridge tests runnable without a GUI, and keep the GUI smoke test
  as the one place that needs a session.
