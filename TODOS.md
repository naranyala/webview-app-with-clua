# TODOs

This is the implementation backlog for the intents in
[`PYRAMID-OF-INTENTS.md`](./PYRAMID-OF-INTENTS.md). Every item has an intent
reference, a priority, and a definition of done. Complete items should be
removed or moved to a changelog rather than left ambiguous.

Priority levels:

- **P0** — blocks the intended happy path or makes the project misleading.
- **P1** — important for a dependable starter project.
- **P2** — improves maintainability, portability, or teaching value.
- **P3** — optional polish or a future extension.

## P0 — Make the documented product work end to end

### TODO-001 — Make the full test command runnable on a clean supported setup — DONE

- **Intent:** I0.1, I1.3, I4.3
- **Priority:** P0
- **Work:** Document and validate the Lua development package lookup used by
  `Makefile`; support the documented Lua 5.3/5.4 variants or narrow the
  documentation to the versions that are actually supported.
- **Done when:** A documented clean setup can run `make test` successfully,
  and a missing dependency produces a precise remediation message.
- **Evidence:** `check-lua` validates the Lua executable and pkg-config
  compiler/linker metadata, supports `LUA_PKG=...`, and emits targeted setup
  guidance.

### TODO-002 — Add a repeatable desktop smoke test — DONE

- **Intent:** I1.1, I1.2, I2.1, I4.1
- **Priority:** P0
- **Work:** `METRICS_SMOKE=1` makes the host inject a marker before the page
  scripts and bind `smokeVerdict`; the bundle then (`frontend-vue/src/smoke.js`)
  checks the rendered shell and drives the real bridge — `summarize` with
  representative values and with bad input, `loadWorkspace`, and, when the run
  is isolated, a `saveWorkspace`/`loadWorkspace` round trip. The verdict is
  decoded strictly by the host (`src/smoke.c`), printed as one
  `SMOKE VERDICT` line, and becomes the process exit code, so
  `scripts/smoke.sh` can run the real application once per render mode
  (`file://` URL and inline `set_html`) under a timeout and fail loudly. The
  script builds what is missing, refuses to run without a graphical session,
  and redirects `XDG_DATA_HOME` into a temporary directory so a smoke run can
  never read or rewrite a real workspace; `window.__METRICS_SMOKE_WRITABLE__`
  is what allows the round-trip check at all.
- **Done when:** CI or a documented local command proves that the actual
  frontend-to-C path works, not just that each component compiles, in both
  render modes.
- **Evidence:** `make smoke-test` (also `lua build.lua smoke`) reports
  `checks=5/5` in both modes on a Wayland session; the run is a real
  fail-detector — an early revision failed with
  `checks=4/5 failed: dom-anchors (missing …)` and exited 1. The host half is
  unit tested by `make smoke-unit-test` (`tests/test_smoke.c`: env detection,
  markers, the strict decoder's malformed-request table, the binding's ack,
  exit code, and the paths that must not terminate) and the frontend half by
  `frontend-vue/tests/smoke.test.js` (17 tests with stub bindings, including
  the missing-host and rejected-verdict paths). Documented in
  `docs/testing.md` ("Desktop smoke test") and `docs/bridge-protocol.md`.

### TODO-003 — Keep frontend, bridge, and documentation contracts synchronized — DONE

- **Intent:** I1.2, I1.3, I3.3, I4.4
- **Priority:** P0
- **Work:** Document the `summarize` request/response contract and remove or
  clearly label any legacy Lua-generated UI path that is not part of the
  desktop build.
- **Done when:** A contributor can identify one authoritative desktop UI path,
  its request shape, its response shape, and its error behavior.
- **Evidence:** The contract is documented in `docs/bridge-protocol.md`; the parser is
  separated into `src/webview_bridge.c`; the desktop build uses `frontend-vue`
  as its authoritative UI (the Octane UI this entry predates has since been
  removed).

## P1 — Make the native boundary dependable

### TODO-004 — Add direct tests for the WebView request parser — DONE

- **Intent:** I3.3, I3.4, I4.1
- **Priority:** P1
- **Work:** Extract the request parsing/summarization function behind a small
  testable interface and cover valid arrays, empty arrays, malformed JSON-like
  input, trailing data, non-finite values, and numeric overflow.
- **Done when:** Parser tests run without opening a WebView window and cover all
  documented error cases.
- **Evidence:** `make bridge-test` builds and runs `tests/test_bridge.c`.

### TODO-005 — Make bridge errors structured and consistent — DONE

- **Intent:** I2.2, I2.3, I3.4
- **Priority:** P1
- **Work:** Define an error response shape, for example `{ "error": { "code":
  "...", "message": "..." } }`, and update C, frontend, and documentation to
  use it consistently.
- **Done when:** The frontend can distinguish invalid input, empty input,
  native failure, and unavailable bridge without parsing human prose.
- **Evidence:** The bridge returns typed error codes, the frontend decodes
  rejected JSON payloads and returned error objects, and bridge tests verify the
  codes.

### TODO-006 — Improve numerical stability of summary calculation — DONE

- **Intent:** I1.1, I2.3, I3.1, I4.2
- **Priority:** P1
- **Work:** Replace the naive `sum_of_squares - mean * mean` variance calculation
  with a numerically stable online algorithm such as Welford’s method, and
  decide whether the API reports population or sample variance.
- **Done when:** Tests cover large magnitudes, closely spaced values, negative
  values, and the selected variance definition.
- **Evidence:** `src/metrics.c` now uses Welford’s online population variance;
  `tests/test_metrics.c` covers large, closely spaced values.

### TODO-007 — Harden lifecycle and allocation failure paths — DONE

- **Intent:** I3.1, I3.2, I3.4, I4.1
- **Priority:** P1
- **Work:** Audit repeated destruction, Lua garbage collection, failed userdata
  allocation, and all early-return paths for leaks or use-after-free risks.
- **Done when:** Sanitizer or equivalent checks cover the C core and Lua binding,
  and lifecycle behavior is documented.
- **Evidence:** `metrics_destroy` guards against NULL; `test_metrics` covers
  operations after destroy, reset cycles, and large-then-reset scenarios;
  sanitizer builds pass without errors.

### TODO-008 — Add frontend behavior tests — DONE

- **Intent:** I2.1, I2.2, I2.3, I4.1
- **Priority:** P1
- **Work:** Test parsing, invalid-token handling, loading state, successful
  rendering, native error rendering, and missing-bridge behavior with a mocked
  `window.summarize`.
- **Done when:** A frontend test command runs without a desktop WebView and
  verifies the user-visible states.
- **Evidence:** At closure, `frontend-octane/npm test` covered input parsing,
  bridge error decoding, formatting, and summary rendering through
  `src/metrics-ui.js`. The live suite is now `frontend-vue/npm test`; the
  legacy UI and its reserved helpers have been removed.

## P2 — Improve portability and contributor experience

### TODO-009 — Add a CI matrix for core, Lua, and frontend workflows

- **Intent:** I1.3, I2.4, I4.1, I4.3
- **Priority:** P2
- **Work:** Add a GitHub Actions matrix running C tests, sanitizer builds, Lua
  integration tests, frontend formatting/build/tests, and where GTK/WebKit are
  available the desktop compile, on supported Linux configurations.
- **Done when:** Pull requests automatically detect broken native, Lua,
  frontend, and contract assumptions.

### TODO-010 — Make dependency acquisition reproducible

- **Intent:** I1.3, I3.5, I4.3
- **Priority:** P2
- **Work:** Document or vendor/cache the pinned WebView dependency strategy and
  make the first-time network requirement explicit.
- **Done when:** Offline and first-run behavior are documented, and the pinned
  version is visible in one authoritative place.

### TODO-011 — Add an explicit protocol/architecture diagram to the README — DONE

- **Intent:** I0.1, I1.2, I1.3, I4.4
- **Priority:** P2
- **Work:** Show the data flow from desktop UI input to WebView binding to C
  parser to metrics engine and back to the result view; show Lua as a
  separate path.
- **Done when:** The README explains the two consumers of the shared C core in
  one concise diagram or equivalent sequence.
- **Evidence:** `README.md` now includes the C/Lua/WebView architecture diagram
  and ownership summary.

### TODO-012 — Add command-line options for example data and output mode

- **Intent:** I1.3, I1.4, I2.4
- **Priority:** P2
- **Work:** Make the Lua demo and/or a small native CLI accept input data and a
  machine-readable output mode for easy experimentation and scripting.
- **Done when:** A contributor can exercise the core without the WebView UI and
  compare output with the desktop path.

## P3 — Extend the example without weakening the seams

### TODO-013 — Support file or pasted multiline input — DONE

- **Intent:** I1.1, I2.1, I2.2
- **Priority:** P3
- **Work:** Define whether whitespace/newlines are valid separators and extend
  the UI and bridge contract accordingly.
- **Done when:** The grammar is documented, tested, and errors identify the
  offending input when possible.
- **Evidence:** Bridge parser accepts newlines as separators between numbers;
  frontend `parseValues()` splits on `/[,\n]+/`; tests cover newline-separated
  and mixed comma-newline input in both C and JS.

### TODO-014 — Add export/copy of the summary — DONE

- **Intent:** I2.1, I2.3
- **Priority:** P3
- **Work:** Provide a copy-to-clipboard or JSON export action without changing
  the native computation contract.
- **Done when:** Users can copy the displayed result and receive feedback that
  the action succeeded or failed.
- **Evidence:** `copyResult()` uses clipboard API with fallback; `exportHistory()`
  creates JSON download; status text shows success/failure feedback.

### TODO-015 — Add a second native capability as a seam-validation exercise — CLOSED

- **Intent:** I0.1, I1.4, I3.1, I4.4
- **Priority:** P3
- **Work:** Add a small independent operation, such as percentile or a moving
  average, through the C API, Lua wrapper, bridge, and UI only if the existing
  contracts remain narrow.
- **Done when:** The new capability has C tests, Lua coverage, bridge coverage,
  and frontend coverage without duplicating engine ownership logic.
- **Evidence:** Closed by the second capabilities themselves: `extractPdfToc`,
  `openImageDirectory`, and the workspace bindings shipped with C tests
  (`test_pdf_toc`, `test_app_support`, `test_workspace_store`), bridge
  coverage, and frontend session tests, all through the same narrow seams. The
  Lua surface intentionally stays metrics-only (I1.4), so the Lua-coverage
  clause no longer applies.

## Execution plan — remaining gaps

The following items turn the current review into an explicit implementation
sequence. The first slice is intentionally limited to correctness, contract
consistency, and low-risk editor usability. The second slice requires a real
desktop or CI environment and remains planned rather than implied complete.

### TODO-016 — Make response-buffer sizing a hard bridge contract — DONE

- **Intent:** I3.3, I3.4, I4.1
- **Priority:** P1
- **Work:** Reject truncated success or error JSON, clear an undersized output
  buffer, document the behavior, and test both success and error responses.
- **Done when:** A caller never receives a successful status with malformed or
  truncated JSON.
- **Evidence:** `write_summary` and `write_error` now detect `snprintf`
  truncation; bridge tests expect undersized buffers to return failure.

### TODO-017 — Test the actual editor interactions in a DOM harness

- **Intent:** I1.5, I4.1, I4.4
- **Priority:** P1
- **Work:** Add a DOM-capable test harness for `App.vue` (jsdom plus Vue test
  utilities) covering the editor gate picker, the TOC management actions, view
  transitions, and native-call success and failure paths.
- **Done when:** `npm test` exercises the component event paths instead of only
  asserting static source contracts over the template.

### TODO-018 — Prevent static-shell and component drift — DONE

- **Intent:** I1.2, I1.3, I3.5, I4.4
- **Priority:** P1
- **Work:** Define the static HTML shell as a deliberate fallback and add a
  contract test checking that its required IDs, toolbar actions, and editor
  defaults remain compatible with `App.vue`.
- **Done when:** A change to either entry point fails a repeatable parity check
  before it can silently break WebView startup.
- **Evidence:** `frontend-vue/tests/static-shell.test.js` checks shared element
  IDs, CSS classes, ARIA labels, textarea defaults, and placeholder text
  between `frontend-vue/public/index.html` and `App.vue` — both under
  `frontend-vue`, replacing the earlier `public/index.html`/`App.tsrx` pair.

### TODO-021 — Provide a reproducible Lua development environment

- **Intent:** I1.3, I1.4, I4.3
- **Priority:** P2
- **Work:** Add a documented container or setup script with a supported Lua
  version, headers, pkg-config metadata, and the exact commands for `make test`.
- **Done when:** A new contributor can run the complete Lua workflow without
  discovering distro-specific package names manually.

### TODO-022 — Make WebView dependency acquisition immutable

- **Intent:** I1.3, I3.5, I4.3
- **Priority:** P2
- **Work:** Replace the mutable WebView Git tag dependency in
  `CMakeLists.txt` (`GIT_TAG 0.12.0`) with the immutable commit for that tag —
  the local FetchContent clone resolves it to
  `3ab4b5d722438fc8a13e6ca830c5e2372d19a01d` — and document cache/offline
  behavior.
- **Done when:** Repeated clean builds resolve the same WebView source and
  first-run network requirements are explicit.

### TODO-023 — Add installation and release artifacts

- **Intent:** I0.1, I1.3, I2.4, I3.5
- **Priority:** P2
- **Work:** Add a CMake install target or release packaging path containing the
  desktop binary and self-contained frontend artifact, with platform notes.
- **Done when:** A built project can be installed or archived without relying
  on the source checkout layout.

### TODO-024 — Improve editor accessibility and low-friction actions — DONE

- **Intent:** I2.1, I2.3, I2.4
- **Priority:** P3
- **Work:** Add a keyboard shortcut for Run and a Copy action with visible
  success/failure status while preserving the minimal editor surface.
- **Done when:** Users can submit with Ctrl/Cmd+Enter and copy a completed
  result without leaving the editor.
- **Evidence:** Delivered at the time by `App.tsrx`: keyboard submission plus
  clipboard/fallback copying, with the top toolbar exposing `Copy`. That
  metrics-era editor surface has since been replaced by the workspace editor,
  and `frontend-vue/tests/static-shell.test.js` now asserts those metric
  controls are absent; the current low-friction actions are outline
  prev/next navigation, autosave status, and keyboard image-lightbox controls.

### TODO-025 — Audit intent and documentation claims after each slice

- **Intent:** I0.1, I1.2, I1.3, I4.4
- **Priority:** P1
- **Work:** Remove stale known-gap claims, keep the documentation authoritative
  for the Vue desktop UI, and record test/build evidence for completed items.
  Partly done: the frontend guide, README tree, and overview no longer
  reference the removed legacy UI or the reserved metrics helpers; the Octane
  claims in `docs/architecture.md`, `docs/overview.md`, `docs/README.md`, and
  the pyramid's current-state snapshot bullet remain.
- **Done when:** README, intent pyramid, TODOs, architecture docs, and source
  layout describe the same runtime path.

## Workspace integration — connecting the four menu tools

These items implement **I1.5** and **I2.5**: the Text Editor, TOC Manager,
PDF Reader, and Image Viewer must share one persisted store and be able to
reference each other's content.

### TODO-026 — Unify workspace state behind one persistent store — DONE

- **Intent:** I1.5, I2.5, I4.4
- **Priority:** P1
- **Work:** Replace the isolated `native-workspace.toc-items.v1` key with a
  single `native-workspace.workspace.v1` record holding the active view, the
  declared outline, the bound item, the untitled editor buffer, the PDF
  session, and the image selection. Migrate the legacy key, debounce writes,
  and flush on unload.
- **Done when:** Restarting the app restores the last view, the outline, the
  bound section, and the untitled buffer; a legacy outline is migrated without
  data loss; the store is covered by pure unit tests.
- **Evidence:** `frontend-vue/src/workspace.js` holds the schema, legacy-key
  migration, debounced write, and flush path; `tests/workspace.test.js` covers
  normalization, migration, and save/load (26 tests pass under `npm test`).

### TODO-027 — Surface live workspace state on the menu cards — DONE

- **Intent:** I1.5, I2.5, I2.4
- **Priority:** P2
- **Work:** Replace the static card subtitles with derived state: outline
  count and written sections, current section and word count, last PDF with
  page position, and last image folder with file count.
- **Done when:** The menu alone tells the user what each tool currently holds.
- **Evidence:** `outlineBadge`, `editorBadge`, `pdfBadge`, and `imagesBadge` in
  `App.vue` replace the static card subtitles; asserted in
  `tests/static-shell.test.js`.

### TODO-028 — Link outline items to PDF pages — DONE

- **Intent:** I1.5, I2.5, I1.2
- **Priority:** P1
- **Work:** Store `links.pdfPage` and `links.pdfName` on an outline item. The
  PDF sidepanel attaches the current page to a chosen outline item; the
  outline row and the editor top bar show the link and jump back to that page.
- **Done when:** A section can be written against a specific source page and
  navigated in both directions without re-entering the page number.
- **Evidence:** `attachPdfPageToToc()` stores `links.pdfPage`/`links.pdfName`,
  `openLinkedPdfPage()` jumps from the outline row and the editor top bar
  (`#open-linked-pdf`); both are covered by `tests/static-shell.test.js`.

### TODO-029 — Attach images to outline sections — DONE

- **Intent:** I1.5, I2.5
- **Priority:** P2
- **Work:** Store `links.images` (relative paths) on an outline item. The
  image viewer attaches the previewed image to a chosen section, the outline
  row shows an image badge with resolved thumbnails when the folder is loaded,
  and an unloaded attachment is reported as unresolved instead of silently
  dropped.
- **Done when:** Attaching an image survives a restart and resolves once the
  same folder is selected again.
- **Evidence:** `attachImageToToc()` from the lightbox records relative paths,
  `openLinkedImages()` resolves them or reports unresolved attachments, and
  the outline row renders an `IMG n` badge.

### TODO-030 — Import extracted PDF headings into the declared outline — DONE

- **Intent:** I1.5, I1.2, I4.4
- **Priority:** P2
- **Work:** Add one action in the PDF sidepanel that converts the headings
  from `extractPdfToc` into declared outline items, preserving level and page
  links, without changing the native extraction contract.
- **Done when:** A PDF's structure becomes the writable outline in one action,
  and re-running the import cannot duplicate existing headings.
- **Evidence:** `importPdfHeadingsToToc()` converts `extractPdfToc` headings
  into items, keeps level and page links, and skips titles already declared.

### TODO-031 — Restore the last PDF and image session after restart — DONE

- **Intent:** I2.5, I1.3
- **Priority:** P1
- **Work:** Persist document name, size, `file://` source, page, and zoom, plus
  the image directory name and selected group. On boot, attempt to re-open the
  PDF source and land on the saved page; on failure show a precise re-open
  prompt. Report unresolved image attachments after a restart.
- **Done when:** A restart returns the reader to the same page when the source
  is still reachable, and degrades to an explicit prompt when it is not.
- **Evidence:** `setPdfDocument()` records name, size, `file://` source URL,
  document id, page, and zoom; `resumePdfSession()` runs on boot and when the
  PDF view opens, with an explicit `Resume session` button and status text when
  the source is unreachable. TODO-032 stays open for the native fallback.

### TODO-033 — Persist the workspace through the native host — DONE

- **Intent:** I2.5, I1.3, I4.4
- **Priority:** P1
- **Work:** WebView storage never reaches disk in the default inline render
  mode, so closing the app dropped every state. Move durability into C: a
  tested file store, `loadWorkspace`/`saveWorkspace` bindings, and a frontend
  that hydrates from disk on boot while keeping `localStorage` as the
  synchronous cache, with `savedAt` resolving conflicts.
- **Done when:** Closing and reopening the app restores the last view,
  outline, drafts, PDF position, and image selection regardless of render mode.
- **Evidence:** `src/workspace_store.c` with `tests/test_workspace_store.c`
  (34 frontend tests plus C and sanitizer runs), bindings in
  `src/webview_app.c`, and the hydration path in `App.vue`.

### TODO-032 — Add a native recent-document command if URL restore proves unreliable — CLOSED

- **Intent:** I1.2, I3.3, I4.4
- **Priority:** P3
- **Work:** Only if the frontend `file://` restore path is blocked by WebView
  origin rules: store the last accepted path natively, expose a
  `restorePdf` binding that re-runs the existing validation, and document it
  in the bridge protocol with tests.
- **Done when:** The reader can re-open its last document without user
  interaction, or the TODO is closed with evidence that the frontend path is
  sufficient.
- **Evidence:** Closed with evidence of sufficiency, not new work: TODO-031
  proved the frontend path adequate — the reader resumes from its stored
  `file://` source and degrades to an explicit re-open prompt when the source
  is unreachable, so no native restore command is needed.

## OpenStreetMap explorer — the fifth grid tool

These items implement **I1.6**: the fifth grid card is a map whose tiles,
search, and location arrive through narrow native bindings, and whose
position and bookmarks live in the shared workspace. Planned in full; not yet
started.

### TODO-034 — Add the map shell as the fifth grid tool

- **Intent:** I1.6, I1.5, I2.5
- **Priority:** P1
- **Work:** Add the fifth grid card, the `map` entry in `VIEWS`, and the
  `.map-app` view with a right-hand rail holding four placeholder tools;
  wire badge, status, and the workspace restore path, with
  static-shell and workspace tests.
- **Done when:** The menu shows five cards, the explorer opens and returns to
  the menu, the rail buttons report status, and a restart restores the map
  view.

### TODO-035 — Build the pure native map layer

- **Intent:** I1.6, I3.3, I4.1
- **Priority:** P1
- **Work:** Add `src/json_mini.c` (strict reader for untrusted responses) and
  `src/map_store.c` (layer table, tile URL building, host allowlist, bounds
  checks, disk-cache read/write/prune, request parsing, response builders)
  with `tests/test_json_mini.c` and `tests/test_map_store.c`, wired into
  Makefile, build.lua, and CMake.
- **Done when:** `make test` and `make sanitized-test` cover URL construction,
  allowlist rejections (http, userinfo, suffix spoofing), cache pruning, and
  exact JSON replies without any network access.

### TODO-036 — Fetch tiles and places through a native transport

- **Intent:** I1.6, I1.2, I3.3, I3.4
- **Priority:** P1
- **Work:** Add `src/map_session.c`: one persistent worker with a task queue,
  libcurl (https-only, timeouts, size caps, custom User-Agent), rate floors
  (≥200 ms tiles, ≥1 s search), Nominatim response reshaping, and the
  `fetchMapTile` / `searchMapPlaces` bindings; extend the native-bridge
  helpers to forward arguments; wire CURL into the build with `check-curl`.
- **Done when:** Warm fetches answer from cache with a `cached` flag, cold
  fetches return a `dataUrl`, and every failure path (offline, HTTP error,
  too large, timeout, unknown layer) returns a typed
  `{error:{code,message}}` — no raw network JSON reaches the page.

### TODO-037 — Render the tile canvas with pan and zoom

- **Intent:** I1.6, I2.5, I4.1
- **Priority:** P1
- **Work:** Add `map-tiles.js` (pure mercator math: visible tiles, x wrap,
  y clamp, zoom bounds), the tile lifecycle in `map-session.js` (in-flight
  dedupe, error tiles, LRU), pointer drag pan and wheel zoom in `App.vue`,
  and the attribution footer.
- **Done when:** Tiles render as data URLs, panning across the antimeridian
  and clamped latitudes stays coherent at every supported zoom, and the math
  is covered by `tests/map-tiles.test.js`.

### TODO-038 — Wire the Layers and Search rail tools

- **Intent:** I1.6, I1.2, I4.1
- **Priority:** P1
- **Work:** Layers panel (three basemaps, attribution swap, persistence) and
  search panel (600 ms debounce, single-flight, stale-response guard →
  `searchMapPlaces`, jump to result), each with busy, empty, and error
  status.
- **Done when:** Switching layers re-tiles while reusing the native cache,
  search results move the map, and every state is distinguishable in the UI
  and covered by `tests/map-session.test.js`.

### TODO-039 — Wire Locate and bookmarks

- **Intent:** I1.6, I2.5, I3.4
- **Priority:** P2
- **Work:** Add the `locateMapPlace` binding (GeoClue2 over the system bus,
  bounded wait, `LOCATE_UNAVAILABLE` / `LOCATE_DENIED` / `LOCATE_TIMEOUT`
  graceful errors) and bookmark add/jump/remove persisted in `workspace.map`
  with normalization (unknown layer → `osm`, zoom clamp, malformed entries
  dropped, cap 200).
- **Done when:** Locate centers the map where the daemon and agent exist and
  degrades to a precise message where they do not; bookmarks and the last
  center/zoom/layer survive a restart; `tests/workspace.test.js` covers the
  map schema round-trip.

### TODO-040 — Document map sources, limits, and the fifth tool

- **Intent:** I1.6, I4.4, I4.3
- **Priority:** P2
- **Work:** Add `docs/map-sources.md` (layer table, host allowlist, rate
  floors, attribution, OSM tile-usage policy and the Nominatim contact-email
  TODO), document the three bindings in `docs/bridge-protocol.md`, and update
  `docs/frontend.md`, `docs/testing.md`, `docs/overview.md`, and `README.md`
  so no page still claims the workspace has four tools.
- **Done when:** A contributor can find the hosts, limits, and attribution
  requirements in one document, and every doc agrees with the five-tool UI.

### TODO-041 — Keep tile usage within policy headroom

- **Intent:** I1.3, I4.3
- **Priority:** P3
- **Work:** Make the inter-request rate floor configurable and document an
  escape hatch (app-provided or local tile source such as MBTiles) if demand
  ever exceeds third-party raster policy.
- **Done when:** The default remains policy-safe, and the alternative path is
  documented rather than implied to be unlimited.

## Editor and outline management UX

These items round out the writing flow inside **I1.5**: the editor always
knows which section is being written, and the TOC Manager manages the outline
from one surface.

### TODO-042 — Gate the Text Editor behind a picked outline section — DONE

- **Intent:** I1.5, I2.5
- **Priority:** P1
- **Work:** Opening the editor with no resolvable active outline item shows a
  section picker (`.toc-pick`) instead of the textarea: pick a declared item
  to load its draft, or jump to the TOC Manager to declare the first one.
  Keyed off `activeTocItem`, so stale ids from old snapshots also gate.
- **Done when:** Every draft belongs to a declared section; the empty-outline
  path routes to the declare flow; boot restore on the editor view degrades to
  the picker when the section no longer exists.
- **Evidence:** `tests/static-shell.test.js` ("Opening the text editor
  requires a picked outline section"); title/status fallbacks moved to
  "No section selected" / "Pick a section to start writing".

### TODO-043 — Rebuild the TOC Manager around one management surface — DONE

- **Intent:** I1.5, I2.5
- **Priority:** P1
- **Work:** Replace the two-column declare-form layout with a single card:
  inline create bar (`toc-declare-bar`), inline row editing (title + level
  with Save/Cancel), move up/down reordering (disabled while filtering or at
  the ends), immediate removal with an Undo button in the toolbar, and a
  title filter that appears at eight or more items.
- **Done when:** Title and level are editable without losing the draft, links,
  id, or position; order is adjustable; removal is undoable until the next
  outline mutation; large outlines are filterable.
- **Evidence:** `tests/toc-outline.test.js` covers inline edit (trim, empty
  rejection, level clamp, draft/link preservation), reordering bounds and
  filter guard, undo restore and its invalidation, and filter thresholds;
  `tests/static-shell.test.js` ("TOC Manager manages the outline from one
  surface") locks the template and stylesheet contracts.

### TODO-044 — Import and export the outline as JSON through the system picker — DONE

- **Intent:** I1.5, I2.5
- **Priority:** P1
- **Work:** `Export…` writes the whole outline through the native
  `saveTextFile` binding (GTK save dialog with overwrite confirmation) as a
  versioned envelope `{"format":"metrics-toc","version":1,"items":[…]}` with
  ids omitted; `Import…` reads one via `openTextFile` and appends sections
  after the existing items with fresh ids (non-destructive), falling back to
  a hidden `input[type=file]` / anchor download outside the host.
- **Done when:** Exports round-trip drafts, levels, and links; malformed,
  wrong-format, wrong-version, and empty files report through the TOC status
  line without mutating the outline; cancels and native errors are surfaced.
- **Evidence:** `tests/toc-outline.test.js` (envelope shape, append with
  fresh ids, round-trip, rejection matrix, save/open outcomes, fallback
  input), `tests/file-io.test.js` (native branches and browser fallbacks),
  `tests/static-shell.test.js` ("Import and export actions are wired for the
  outline and the draft"), and `make text-transfer-test` for the C side.

### TODO-045 — Import and export the active draft through the system picker — DONE

- **Intent:** I1.5, I2.5
- **Priority:** P1
- **Work:** `Export…` writes the picked section's draft through
  `saveTextFile` under a sanitized, UTF-8-capped file name derived from the
  section title; `Import…` reads a text file through `openTextFile` and
  replaces the buffer, flushing it into the outline item via `syncTocDraft()`
  so word count and workspace stay in step; feedback shows in a footer
  notice; both actions are gated on a picked section like the editor itself.
- **Done when:** The draft, outline item, and persisted workspace agree after
  an import; exports refuse without a section; cancels, native errors, and
  browser fallbacks all report without throwing.
- **Evidence:** `tests/toc-outline.test.js` (replace-and-sync, cancel/error,
  gate, fallback input, safe export name), `tests/editor-session.test.js`
  (notice lifecycle), `tests/native-bridge.test.js` (argument forwarding on
  both host paths), and the static-shell wiring test above.

## Abstraction rework — making the seams real

A full-codebase audit of the three layers (C host, Vue frontend, Lua) found
that the layering *intent* is already documented and mostly honoured, while
four concrete abstractions are missing and each one is now a source of
duplication, untested logic, or silent data loss. These items implement
**I3.3**, **I3.4**, and **I4.4**; the evidence in each entry is the audit
finding that justifies the work.

### TODO-046 — Give the C host one JSON codec and one error contract — DONE

- **Intent:** I3.3, I3.4, I4.4
- **Priority:** P1
- **Work:** There is no single owner for JSON, so five modules wrote their own
  (four error writers, three string decoders — `text_transfer.c:18-121` and
  `workspace_store.c:177-293` are the same ~100 lines twice). Add a
  webview-free `json_io.h`/`json_io.c` owning `append_json_string`, one
  `json_read_string()` primitive (escapes, `\uXXXX` with surrogate pairs, an
  explicit control-byte policy), and one `native_error` enum with
  `return_native_error`/`native_error_strerror`. Delete `json_escape()` — its
  shared 4 KiB static buffer silently truncates the PDF URL
  (`pdf_session.c:165-173` feeds it a `PATH_MAX * 3 + 8` buffer) — and delete
  the unescaped `return_workspace_error` (`workspace_bindings.c:35-43`), whose
  doc comment claims a contract the frontend never consumes.
- **Done when:** every byte the host emits comes from one writer, every
  request string is read by one reader (so the two grammars can no longer
  diverge), and `src/pdf_toc.c` compiles without GTK or the webview stub.
- **Evidence:** `include/json_io.h` + `src/json_io.c` own `json_append_string`,
  `json_append_error`, and `json_read_string_array()` (measure-then-allocate,
  so a decoded value is sized exactly and a raw control byte is rejected by
  every binding alike). `json_escape()` and the unescaped
  `return_workspace_error` are gone, along with the inline error literals in
  `webview_app.c` and the clone in `pdf_session.c`; `picker_request_release()`
  now owns every `picker_request` teardown (2 of 4 sites leaked the payload).
  `tests/test_json_io.c` (new, `make json-io-test`) covers the writer and the
  reader, including the malformed table and the surrogate pair. `make test`,
  `make sanitized-test`, `lua build.lua test`, and `make smoke-test` (5/5 in
  both render modes) are green; `test_pdf_toc` now links only glib, dropped
  `-Itests/stubs` and its three hand-written `webview_*` stubs, and
  `test_bridge`/`test_workspace_store` gained the codec.
- **Follow-up:** the ~24 code strings are still literals at their call sites.
  A `native_error` enum plus a docs-vs-source contract test remains open (see
  TODO-052's test-registry work).

### TODO-047 — Extract the workspace persistence engine out of App.vue — DONE

- **Intent:** I1.5, I2.5, I4.1
- **Priority:** P1
- **Work:** `App.vue:229-335` holds the snapshot builder, the 250 ms debounce,
  the localStorage→native write ordering, and the boot/native `savedAt`
  reconciliation — and hand-writes a second copy of the workspace schema
  (`App.vue:229-248` vs `workspace.js:134-151`). Move it into
  `src/workspace-persistence.js` with injected `workspace`, `storage`,
  `native`, and `now`, following the injection style `smoke.js` already uses.
  `persistNow` must return the awaited native result: `persistWorkspace()`
  returns `true` unconditionally today (`App.vue:280`), so a failed desktop
  save never reaches `saveTocItems()`'s error branch (`toc-outline.js:141`) —
  dead code in the shipping configuration.
- **Done when:** the persistence loop is unit tested with an injected storage
  and a fake native store, covering the failure path, the debounce, and the
  `savedAt` tie; the snapshot has exactly one definition; and `App.vue`
  contains no schema or write-ordering logic.
- **Evidence:** `frontend-vue/src/workspace-persistence.js` owns the snapshot,
  `apply`, `persist`, `flush`, `schedule` (250 ms), `hydrate`, the mode, and
  the header report, with `sessions`, `store`, `boot`, `now`, and `timers`
  injected. `App.vue` is down to 796 lines and only wires it (plus the one
  policy decision it must make: a workspace that reached no store at all is
  also a TOC-level problem). `tests/workspace-persistence.test.js` (22 tests)
  covers the snapshot, all three write outcomes, the debounce collapse, the
  four hydration cases, and the report. `saveTocItems()` no longer assigns
  `tocStatusError = !saved`, which used to clear the error state the async
  failure callback had just set. 184/184 frontend tests, `npm run build`, and
  `make smoke-test` (5/5, both modes) are green.

### TODO-048 — Turn the session singletons into factories — DONE

- **Intent:** I4.1, I4.4
- **Priority:** P2
- **Work:** ~60 module-level exported `ref`s and 10 module `let`s make the
  frontend a global singleton: `boot-state.js:10` reads `localStorage` at
  import time (so every test file transitively touches real storage) and
  `tests/toc-outline.test.js:8` has to reset shared state by hand. Convert
  `pdf-session`, `image-session`, `editor-session`, and `toc-outline` to
  `create*Session(deps)` factories, and route `document`, `window`,
  `FileReader`, and `URL` through injected seams instead of direct globals.
  This is the prerequisite for TODO-017.
- **Done when:** two independent app states can exist in one test process, and
  no module reaches for a global it was not given.
- **Evidence:** all five sessions are factories —
  `createAppShell`, `createEditorSession`, `createImageSession`,
  `createPdfSession`, `createTocOutline` — each taking what it used to reach
  for: `boot`, `doc`, `native`, `call`, `defer`, `pixelRatio`, `revokeUrl`,
  and (for the outline) its editor, PDF, image, and shell collaborators plus the
  transfer wrappers. `toc-outline.js` no longer imports its siblings; it takes
  them, defaulting to the app's instances. Each module still creates one
  default instance at import and re-exports its members, so App.vue and the
  existing 199 tests are untouched by the refactor.
  `tests/session-factories.test.js` (12 tests) is the proof: two of each
  session coexist in one process with separate state, separate statuses, and
  separate focus targets, and an outline built from stub collaborators declares,
  reorders, undoes, exports, and enforces the image cap without touching the
  real sessions. DOM lookups resolve lazily (`doc = null` then
  `doc ?? globalThis.document`) so a test may install a document after import.
  211/211 frontend tests, `npm run build`, and `make smoke-test` (5/5, both
  render modes) are green.
- **Note:** the default instances are still created at import time, so the
  modules do hold one instance each. Removing that last step means App.vue
  builds the graph explicitly; it is only worth doing together with the DOM
  harness in TODO-017, which can now use these factories.

### TODO-049 — Harden the C host's limits, buffers, and file I/O — DONE

- **Intent:** I3.4, I2.3
- **Priority:** P1
- **Work:** Enforce `TEXT_TRANSFER_MAX_BYTES` *before* reading the file into
  memory (`text_transfer.c:298-313` loads it, then checks); check the
  `snprintf` return at `pdf_session.c:173`, where an overrun currently
  delivers a truncated body with status 0; name every remaining magic
  threshold — `pdf_toc.c:49`'s `180` is compared against `GString.len`, which
  is bytes, so non-ASCII headings are dropped while the comment claims
  characters; replace the two hand-rolled whole-file readers
  (`workspace_store.c:48`, `webview_app.c:133`) with `g_file_get_contents`,
  used elsewhere in the same codebase; and either `fsync` the workspace temp
  file and its directory or soften `include/workspace_store.h:44`'s claim that
  an interrupted write cannot corrupt existing state.
- **Done when:** no response can be delivered truncated, no size cap is checked
  after the allocation it bounds, and the durability comment matches the code.
- **Evidence:** the open-picker path now `g_stat`s before reading, so an
  oversized file is rejected from its metadata and the post-read check only
  guards a file that grew in between. The PDF title cap counts UTF-8
  *characters* (`pdf_toc_count_characters`, new and public so it is testable:
  `tests/test_pdf_toc.c` asserts 180 three-byte characters are 540 bytes and
  still 180 characters), and the four heading thresholds are named
  `PDF_HEADING_*`. `workspace_store_save` now fsyncs the temp file *and* the
  containing directory, so `include/workspace_store.h`'s durability claim is
  true of a power loss, not just a process crash. Both hand-rolled whole-file
  readers (`workspace_store_load`, `load_html`) are gone in favour of
  `g_file_get_contents`, with `load_html` refusing a bundle containing NUL
  bytes. The response-truncation hazard in `openPdf` was removed with TODO-046
  (GString instead of an unchecked `snprintf`). `make test`,
  `make sanitized-test`, and `make smoke-test` (5/5, both modes) are green.

### TODO-050 — One transfer pipeline and one status channel in the frontend — DONE

- **Intent:** I2.2, I2.5
- **Priority:** P1
- **Work:** Six copy-pasted `{error} → {canceled} → success` ladders
  (`pdf-session.js:289`, `image-session.js:151`, `toc-outline.js:369,397,438,471`)
  re-implement the contract `file-io.js:8` already states; delete the second
  native binding resolver (`workspace.js:275` vs `native-bridge.js:15`, which
  disagree on `globalThis` vs `window`); render the four status channels with
  one `<StatusLine>`. Two silent-data-loss fixes belong here:
  `MAX_IMAGES_PER_ITEM` is enforced on read (`workspace.js:59`) but not on
  write (`toc-outline.js:598` pushes unbounded, so the 65th image link is
  dropped on the next load), and the browser image path has no total-byte
  budget, unlike the native scan's 96 MB (`image_directory.c:18`).
- **Done when:** no transfer path re-implements the ladder, one resolver owns
  binding lookup, and the browser fallback honours the same budgets as the
  native scan.
- **Evidence:** `file-io.js` gained `withFileTransfer()` plus
  `withTextFileRead()` / `withTextFileWrite()`; all six ladders
  (`pdf-session.js`, `image-session.js`, and the four TOC/editor transfers)
  now pass a `report` callback and per-tool `messages`, and the pipeline
  returns `{ status, value, result }` with `status` in
  `done | canceled | error | skipped` so callers react without parsing prose.
  `workspace.js` imports `getNativeBinding` instead of keeping a second
  resolver that disagreed about `globalThis` vs `window` (its test now
  installs bindings where the canonical resolver reads them).
  `MAX_IMAGES_PER_ITEM` is exported from `workspace.js` and enforced by
  `attachImageToToc()`, which now refuses the 65th link with a message instead
  of writing a record the next load would silently truncate;
  `MAX_BROWSER_TOTAL_SIZE` (96 MB) mirrors `IMAGE_SCAN_MAX_TOTAL_SIZE`, and
  `imagesFromFileList` stops on the same count and byte budget the native scan
  uses, reporting `skipped` and `totalBytes`. `readFileAsText` prefers a
  File's own `text()` over FileReader. 199/199 frontend tests (17 of them new:
  the pipeline's outcome matrix, the attach cap, and the image budget),
  `npm run check`, `npm run build`, `make test`, `make sanitized-test`,
  `lua build.lua test`, and `make smoke-test` (5/5, both modes) are green.
- **Note:** the four status channels are still four hand-written spans. The
  `<StatusLine>` component is left in TODO-051 with the App.vue split, where
  it belongs.

### TODO-051 — Break App.vue into child components — PARTIAL

- **Intent:** I4.4
- **Priority:** P2
- **Work:** 875 lines with zero child components, 28 `toolbar-button`
  occurrences, byte-identical word-count lines (`App.vue:597` and `:668`),
  a duplicated outline `<select>` (`:806`, `:863`), and ~11 hand-rolled
  pluralizations. Extract one component per tool pane plus the shared
  toolbar/status/empty-state pieces, and fix the accessibility gaps that fall
  out: `aria-live` on the interactive TOC `<nav>` (`:789`), no focus
  trap/restore in the lightbox (`:845-871`), and a keyboard-unreachable PDF
  scroll region (`:814`).
- **Done when:** `App.vue` is a composition root of roughly 200 lines and the
  four panes share one status and toolbar vocabulary.
- **Shipped:** `src/components/StatusLine.vue` is now the one status line, used
  by all four panes (the pane-specific class still falls through, so index.css
  is untouched, while the id/error/title/role/aria-live triple exists once);
  `src/components/LightboxDialog.vue` took the preview out of App.vue and
  brought the missing focus behaviour with it — it takes focus on open, keeps
  Tab inside the dialog, handles Escape, and returns focus to the opener on
  unmount; `src/components/MenuView.vue` took the four tool cards out, leaving
  the app's whole routing surface in one readable component. All three
  accessibility gaps are closed and locked by tests: the TOC `<nav>` is no
  longer a live region (it wraps the entire interactive outline list), the
  reader pane is `role="region"` with `tabindex="0"` and a label so it is not
  mouse-only, and the lightbox restores focus.
- **Evidence:** four new assertions in `tests/static-shell.test.js` cover the
  shared status line, the focus trap and restore, the non-live TOC panel, and
  the keyboard-reachable reader pane; `static-shell.test.js`'s aggregate now
  follows a concern into `src/components/`. 215/215 frontend tests,
  `npm run check`, `npm run build`, and `make smoke-test` (5/5, both render
  modes) are green.
- **Not done:** the per-pane extraction (TOC Manager, editor, image viewer,
  reader). App.vue is 791 lines, not ~200. Each of those panes holds 10-20
  session bindings, so the split is mostly prop plumbing, and the only coverage
  available for a template of that size is the 5-check smoke run — a
  regression there would not be caught by a unit test. Doing it properly wants
  the DOM harness first (TODO-017), which the session factories from TODO-048
  now make possible; the status and lightbox extractions were taken now because
  they are the parts with a real defect or duplication behind them.

### TODO-052 — Make one build system the source of truth for tests — DONE

- **Intent:** I1.3, I2.4
- **Priority:** P2
- **Work:** `Makefile` (36 test entries), `build.lua` (30, hand-mirrored), and
  `CMakeLists.txt` (no `enable_testing`/`add_test` at all) each keep their own
  list; adding `test_smoke.c` meant editing three files, and a forgotten entry
  is silent non-coverage. Register the C tests with CTest, have `build.lua`
  delegate rather than re-declare, and keep `make` as the documented entry
  point. Pairs naturally with TODO-009.
- **Done when:** adding a C test requires one edit, and `ctest` and
  `make test` run the same set.
- **Evidence:** `tests/MANIFEST` lists each suite as
  `profile | name | source...` and is the only place a suite is declared. The
  Makefile turns it into real rules with
  `tools/tests-manifest.awk` (generated into `build/tests.mk` and included, so
  `make -n` stays readable), `build.lua` reads it in `read_test_manifest()` and
  runs suites through `run_c_tests()`, and `CMakeLists.txt` reads it under
  `include(CTest)` to build and register all eight with
  `add_test(... WORKING_DIRECTORY <source root>)`. A profile (`core`, `glib`,
  `glib-math`, `pdftotext`, `gtk-stub`) selects the flags, and adding one is
  three documented edits. The C suite formerly named `smoke` is now
  `smoke-verdict` (`make smoke-verdict-test`) so its generated target cannot
  shadow the GUI `make smoke-test`. `make test`, `make c-tests`,
  `make sanitized-test`, `lua build.lua test`, and `ctest` (8/8) all pass.

### TODO-053 — Move the dead Lua-owned HTML UI into the examples — DONE

- **Intent:** I1.3, I1.4
- **Priority:** P3
- **Work:** `lua/app/ui.lua` is a complete second frontend — its own HTML, CSS,
  JS, and `window.summarize` call — that no build target, test, or run path
  loads, and that duplicates the bridge contract the Vue frontend owns. Per
  I1.4 the Lua-owned surface is worth *preserving*, so move it next to
  `lua/examples/demo.lua` and document it as the minimal bridge example rather
  than deleting the surface outright.
- **Done when:** exactly one presentation layer ships in the app path, and the
  Lua example set still demonstrates the C binding end to end.
- **Evidence:** `lua/app/ui.lua` moved to `lua/examples/ui.lua` (git mv, so the
  history follows) and the now-empty `lua/app/` is gone. Per I1.4 the surface
  is preserved rather than deleted: `lua/examples/README.md` explains that
  `demo.lua` shows the binding alone and `ui.lua` is the smallest possible
  WebView page — one button calling the same `window.summarize` binding — with
  the note that no build target or the desktop app loads it. README, the
  source-layout list, and the architecture doc point at the new path.

## Backlog rules

- Do not add a TODO without an `Intent:` line.
- Prefer one outcome per TODO; split unrelated work.
- Update the intent pyramid when the product boundary or architecture changes.
- Close a TODO only with evidence: a test, build result, documented manual
  check, or an explicit reason the intent no longer applies.
- Use `— DONE` when the work shipped with evidence, and `— CLOSED` when it no
  longer applies and the reason is recorded.
