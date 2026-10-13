# Testing guide

Testing is split by boundary so a failure points to the smallest relevant layer.

Eleven C suites, one Lua suite, 33 frontend suites. Each C suite is declared once
in [`tests/MANIFEST`](../tests/MANIFEST) and read identically by `make`,
`build.lua`, and CMake — so the three runners cannot disagree about what exists,
and adding a suite is a one-line edit.

```sh
make test        # 11 C suites + the Lua suite
make c-tests     # compile the C suites without running them
make sanitized-test
cd frontend-vue && npm test
```

The running theme is that each layer is testable **without the one above it**: the
C suites need no GTK window and no WebView, the frontend suites need no browser and
no host, and the Lua suite needs no UI. Only the smoke test needs a real graphical
session, which is why it is the single place where the wiring is actually proved.

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
request lists. Above the store, the `loadWorkspace` binding re-validates the
file with the shared codec (embedded NUL and non-object documents reject with
`INVALID_CONTENT`), so a damaged copy is reported rather than spliced into a
reply that claims to be JSON.

Run:

```sh
make c-tests && build/test_workspace_store
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
pages), the per-document cache round trip including fingerprint and
format-marker mismatches, and the JSON reply the TOC Manager parses. A
corrupt or missing file reports the extractor's own diagnostic rather than
the empty-document message, a stale error never masks the real outcome, and a
`NULL` error slot is safe. The XDG data directory is redirected into `build/pdf-toc-test`, so the
suite never writes to the real user home. It requires `pdftotext` on `PATH`.

Run:

```sh
make pdf-toc-test
```

### Map tests

The map has more tests than anything else in the frontend, and they are split along
the same lines as the source so each suite covers the module it names.

[`map-projection.test.js`](../frontend-vue/tests/map-projection.test.js) needs no
session at all. It pins the Web Mercator formulas against known slippy-map tile
numbers rather than against the implementation, so a change that breaks real
coordinates fails here instead of quietly shifting the map. It also covers the
layer transform — including the two ways it is easy to get wrong: the scale's sign,
and the fact that the translate must *not* be scaled — plus the prefetch ring, the
scale bar, and the coordinate primitives.

[`map-viewport.test.js`](../frontend-vue/tests/map-viewport.test.js) covers the
shared viewport: zoom commits, the tile **rate floor**, pan, inertia, the pointer
and keyboard handlers, and the loading state. The rate-floor cases assert the
deferral itself rather than the constant, because a test that only checked the
number would pass against a bucket nothing consulted — which is exactly the bug
that left the floor declared and unenforced. One case there pins a defect worth
naming: `mapLoading` measures against the *wanted* tile set, not the admitted one,
so the outgoing layer is not retired while half the screen is still queued.

[`map-explorer.test.js`](../frontend-vue/tests/map-explorer.test.js) covers what
makes this the Explorer rather than a map: the pin, the click-versus-drag
threshold, saved places, the badge, and flights. Travelling uses a clock and a
frame queue the test drives, so a 560 ms journey is stepped frame by frame rather
than waited on — the view interpolates rather than jumps, the tile set is
re-committed often enough that the ground is never magnified past the commit
threshold, the outgoing layer is held until every incoming tile lands, and a grab
or a key cancels the journey without moving the pin.

[`map-canvas.test.js`](../frontend-vue/tests/map-canvas.test.js) builds the canvas
renderer directly, with a recording context and a stub `Image` — node has no `Image`
constructor — and covers the draw path, the transform reaching the context, frame
coalescing, cache eviction, and that a failed tile is not re-fetched every frame.
It asserts that the canvas and the DOM layer place a tile identically, since
switching renderers would otherwise shift the map.

[`map-geojson.test.js`](../frontend-vue/tests/map-geojson.test.js) covers the
imported-layer path: the shape conversion, and that the loader rejects a
malformed FeatureCollection with a message rather than a throw. It pins the
projection at a known view, because the overlay was once placed at zoom 0 while
its ground sat at the tile zoom — correct at scale 1 and thousands of pixels wrong
everywhere else.

[`map-places.test.js`](../frontend-vue/tests/map-places.test.js) covers the
saved-place collection and the view options: the rules that keep a place list
usable (a name is required, a repeat pick does not duplicate, the cap holds, a
duplicate id is dropped).

[`map-places-import.test.js`](../frontend-vue/tests/map-places-import.test.js)
covers reading a file of places. Its interesting cases are the wrong ones: a
swapped coordinate pair, a name containing a comma, more points than the
collection can hold. Each produces a list that looks entirely plausible and is
entirely wrong.

[`google-maps-session.test.js`](../frontend-vue/tests/google-maps-session.test.js)
covers the second viewer: the tile URL for each layer, all five Google URL shapes
including the two that yield no coordinates, and the GeoJSON export. That last one
pins `[longitude, latitude]` order, which is the reverse of the `{lat, lon}` used
everywhere else in the app — getting it backwards opens the file in the wrong
hemisphere and is invisible in review.

[`geo-locate.test.js`](../frontend-vue/tests/geo-locate.test.js) covers locating
the reader, driving all four outcomes with injected geolocation and manual timers,
so no case waits out the twelve-second timeout.

Two checks exist because wiring bugs here are invisible to unit tests. The smoke
run catches an app that fails to mount. And `template-bindings.test.js` plus
biome's `noUndeclaredVariables` cover both directions of a missing import — the
build mounts, renders, and passes every test, then dies on the first click that
reaches the missing name. That check had been red for a while, and it turned out
to be reporting two real bugs: a name the Google toolbar used and never imported,
so its centre label rendered "No location", and a name the GeoJSON overlay used
and never imported.

### Image directory tests

[`tests/test_image_directory.c`](../tests/test_image_directory.c) covers the
bounded directory scan and the lightbox's full-resolution fetch. GdkPixbuf is
linked for real, because the central claim is "the thumbnail is dramatically
smaller than the original" and a fake decoder cannot test a claim about sizes.
Images are generated at runtime with GdkPixbuf rather than checked in as
fixtures, so the suite is not pinned to one decoder's output bytes, and the size
assertion is a ratio rather than an absolute count so it survives a different
libjpeg build.

It covers: a 4032×3024 source producing a 320×240 thumbnail at least 20× smaller
than the original as base64; a portrait image scaled on its long edge; a small
image *not* upscaled; an undecodable file falling back to the original and
incrementing `fallbacks`; `limited` and `fallbacks` present on every reply;
`loadImageAt` serving a scanned path at full resolution; and — the security
property — refusing a path the last scan did not walk, which is what keeps the
binding from being a general file reader reachable from the page.

Needs GTK and gdk-pixbuf, which `make check-gdk-pixbuf` verifies.

Run:

```sh
make image-directory-test
```

### Combined outline PDF tests

[`tests/test_outline_pdf.c`](../tests/test_outline_pdf.c) drives the
`chooseOutlineDirectory` / `renderOutlinePdf` bindings with the webview calls
replaced by recording stubs, so no GUI is involved. It covers the suggested-name
sanitizer (traversal, absolute paths, backslashes, reserved characters, dots
only, an over-long name that stays valid UTF-8), the refusal to write before a
folder has been chosen, the rejection of malformed and non-object outlines,
level clamping, items with no title, pagination of a long document, that a word
too wide for the measure is split rather than dropped, and that a reply can
never imply completeness it does not have (`truncated` is false for a small
render and true for a 10001-item one).

Cairo is linked for real, not mocked: "is this actually a PDF" and "does the page
count go up" cannot be answered honestly against a fake surface. Every case
checks the `%PDF-` header of the file cairo wrote. The suite needs cairo and
glib, which `make check-cairo` verifies.

Run:

```sh
make outline-pdf-test
```

### Combined outline round-trip tests

[`tests/test_outline_roundtrip.c`](../tests/test_outline_roundtrip.c) answers the
one question the two suites above cannot: if this renderer draws a heading, will
the reader's extractor recognise it? It renders through the real
`renderOutlinePdf` binding and reads the file back with the real
`extract_pdf_toc`.

That gap was not hypothetical. `extractPdfToc` re-derives headings from
`pdftotext -tsv` font heights — it never reads a PDF outline tree — and rejects
anything under a 1.25 ratio to the page's median body height. H3 was drawn at
12.5pt against a 10.5pt body, which measures as about 1.19x, so every H3
subsection silently vanished from the preview of a document that contained it.
`test_outline_pdf.c` asserted the page count and `test_pdf_toc.c` asserted
headings in its own fixture; neither asked about headings from *this* renderer.

The suite has four cases: all three levels survive the round trip; a document
re-rendered at the old 12.5pt H3 loses the subsection (a control, so a green
first test means the sizes are load-bearing rather than incidental); the
published `PDF_HEADING_MIN_DETECT_RATIO` in `pdf_toc.h` matches the extractor;
and sentence case is asserted as a *known limit* — `is_title_like` rejects it
however large it is drawn, which is the reader's heuristic and not something the
renderer can fix without mangling the author's capitalisation.

It needs cairo and pdftotext but no GTK, which is why the `cairo-pdftotext`
MANIFEST profile exists: the renderer includes no toolkit header, so the only
GTK-adjacent symbols left are two `app_support` entry points, stubbed here.

Run:

```sh
make outline-roundtrip-test
```

### Text transfer tests

[`tests/test_text_transfer.c`](../tests/test_text_transfer.c) covers the
`openTextFile` / `saveTextFile` plumbing without a GUI: the save argument
decoder (escapes, surrogate pairs, whitespace, malformed and oversized
requests), the suggested-name sanitizer (path stripping, reserved characters,
fallbacks — including a hostile fallback, which is scrubbed like any other
name — UTF-8-safe caps), and the binding-level validation that rejects a
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
reader (escapes, `\uXXXX` with surrogate pairs, rejected `\u0000` and lone
surrogates on both the array and document APIs, exact allocations, raw control
bytes rejected, container growth that holds 10000 siblings, and a table of
malformed requests). Every binding decodes through it, so this is where the
shared grammar is pinned.

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
make smoke-verdict-test
```

(`make smoke-unit-test` names no rule — it is a bare `.PHONY` entry, so it
succeeds while testing nothing. The generated per-suite target is
`smoke-verdict-test`, renamed from `smoke` so it cannot shadow the GUI
`make smoke-test`.)

The sanitized target rebuilds all eleven C test binaries with
AddressSanitizer and UndefinedBehaviorSanitizer.

### Lua integration tests

[`tests/test_core.lua`](../tests/test_core.lua) verifies that the Lua wrapper
can create engines, add values, summarize, reset, chain calls, and surface
invalid values as Lua errors — and that each failure is its own error: an
overflow says overflow rather than "must be finite", a string is rejected
rather than coerced, `from()` names the offending index, the metatable is
locked, and a destroyed handle reports itself on add, summary, and reset.

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

33 suites, run with `npm test` in `frontend-vue/`. No browser, no WebView, no
network. They fall into four groups.

**Sessions** — one file per module, covering the state that module owns:
`app-shell`, `native-bridge`, `file-io`, `editor-session`, `pdf-session`,
`image-session`, `image-viewer`, `outline-pdf`, `workspace`, `workspace-report`,
`workspace-persistence`, and `session-factories`.

**The outline** is large enough to be split by concern rather than left as one
growing file: `toc-outline` covers the outline model and the level rules,
`toc-outline-map-links` the link affordances that bind an item to a PDF page, an
image, or a saved place, and `toc-outline-transfer` the import/export round trip.
All three share `support/toc-fixtures.mjs`, because three suites that each
construct an outline separately drift apart on the first field that changes.

Plus the map set
(`map-projection`, `map-viewport`, `map-explorer`, `map-canvas`, `map-geojson`,
`map-places`, `map-places-import`, `google-maps-session`, `geo-locate`).

**The map's own arithmetic** is split along the same lines as the source, so each
suite covers the module it names: `map-projection.test.js` pins the Web Mercator
formulas against known slippy-map tile numbers with no session at all, and
`map-viewport.test.js` covers zoom commits, the tile rate floor, gestures, and
loading state.

**Static contracts** — `static-shell`, `template-bindings`, `responsive-layout`,
and `csp` read the source and the stylesheet as text. They assert that every
template identifier resolves to a binding, that the template compiles, that the
CSS satisfies its layout invariants, and that the built `dist/index.html` carries
a policy whose `script-src` hash matches its inlined bundle.

**Drift guards** — `menu-cards`, `bridge-bindings`, and `readme-map`. These
exist because documentation does not fail loudly when it becomes wrong, and each
one turns a specific past drift into a red test: the launcher disagreeing with the
static shell and the smoke check about how many tools there are, a binding
registered in C but undocumented, a source file missing from the README map.

#### The mounted component

`component-dom.test.js` is the one suite that mounts the real application. It
drives the event paths the others can only assert about — opening the menu,
TOC, editor, PDF, and image panes, declaring a section, the editor gate
refusing a draft with no section picked, two sections keeping separate drafts, a
draft surviving a view switch, a rejected binding reaching the status line, and a
restored workspace landing on the saved view. The map and Google viewers have
no mounted tests yet (TODO-068): their sessions are covered, their panes are
not.

Three details of the harness are load-bearing, and two of them were found by a
test failing rather than by design:

- **The loader is a `--import` preload, not per-file setup.**
  `@vue/runtime-dom` captures `document` when it is first imported, so a jsdom
  window installed afterwards leaves it holding `null` and every mount dies with
  "Cannot read properties of null (reading 'createElement')" — an error that points
  at Vue rather than at the missing DOM.
- **The DOM is installed by the test file, not globally.** Installing it in the
  preload would hand every suite a real `localStorage` and `document`, which
  silently breaks the "this browser does not allow workspace storage" case and the
  anchor-download stub. Those tests exercise the no-host path, so the harness stays
  opt-in.
- **`?fresh=N` rebuilds the whole graph.** `openApp()` clears `localStorage` and
  re-imports `App.vue` under a token the loader propagates, so the module-level
  session singletons are rebuilt per test rather than inherited from whichever test
  ran last.

#### Shared fixtures

`tests/support/` holds what more than one suite needs: the DOM harness
(`dom.mjs`, `dom-globals.mjs`), the SFC loader and its preload hook, and two
fixture modules — `map-fixtures.mjs` (the tolerance assertion and the session
builders) and `toc-fixtures.mjs` (the outline reset and the persistence counter).
The persistence counter is exported as an accessor rather than a binding, because a
module's exported `let` is live but unassignable from outside and the tests need to
reset it between cases.

#### Running

```sh
cd frontend-vue
npm test        # all 33
npm run check   # biome
npm run build   # the single-file artifact

node --import ./tests/support/register-sfc.mjs --test tests/map-viewport.test.js
```

All of it runs without a browser or WebView. The native bridge itself is covered
on the C side by `make bridge-test` equivalents — see `tests/test_bridge.c`.

## Desktop smoke test

The unit tests prove each piece; the smoke test proves the wiring. It builds
the frontend and the desktop host, launches the real application in a real
graphical session once per render mode (`file://` URL and inline `set_html`),
and lets the frontend check the real DOM and the real bindings:

- the shell rendered (root shell, all six tool panes, the editor gate, six menu
  cards),
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

The complete pass, in the order that fails fastest:

```sh
cd frontend-vue
npm test                       # 33 suites, ~a minute, no browser
npm run check                  # biome lint and format
cd ..

make test                      # 11 C suites + Lua
make sanitized-test            # the C suites again, under a sanitizer

lua build.lua test             # the above plus the frontend checks and build
lua build.lua desktop          # the complete desktop path
```

Then the GUI smoke test, on a machine with a graphical session:

```sh
make smoke-test
```

`make smoke-test` is the only step that cannot run headless, and that gap is
recorded rather than worked around: no CI workflow exists for it, which is how the
menu-card count came to disagree with the app's own smoke check. If you change
anything about the shell, the panes, or the bindings, run it locally.

Expected result for the whole lot: 11/11 C suites, 33/33 frontend suites, the Lua
suite passing, and `SMOKE VERDICT: pass` from both render modes.

## Test design principles

- Test public contracts, not private implementation details.
- Check that rejected input leaves engine state unchanged.
- Include boundary values and malformed protocol input.
- Keep C and bridge tests runnable without a GUI, and keep the GUI smoke test
  as the one place that needs a session.
- Assert that a failure reaches the user. A binding that rejects must change
  what is on screen, not merely not throw.
- Mutation-check a new test. A test that would also pass against the broken
  behaviour is not a test, and reading it green is the only evidence available
  short of deliberately breaking the code to find out.
- Keep a test independent of its neighbours, including of module-level state.
  A shared singleton or a persisted store leaking between tests makes the suite
  order-dependent, which fails silently when the runner reorders.
