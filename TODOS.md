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

### TODO-017 — Test the actual editor interactions in a DOM harness — DONE

- **Intent:** I1.5, I4.1, I4.4
- **Priority:** P1
- **Work:** Add a DOM-capable test harness for `App.vue` covering the editor
  gate picker, the TOC management actions, view transitions, and native-call
  success and failure paths.
- **Done when:** `npm test` exercises the component event paths instead of only
  asserting static source contracts over the template.
- **Evidence:** `tests/component-dom.test.js` (14 tests) mounts the real
  `App.vue` and drives it. `tests/support/sfc-loader.mjs` is a `node:module`
  hook that compiles `.vue` with `@vue/compiler-sfc`; `tests/support/dom.mjs`
  mounts into a jsdom document built from `public/index.html`, so a shell that
  has stopped parsing fails there rather than in the desktop app; and
  `dom-globals.mjs` installs a fake host whose recorded calls and per-binding
  replies let one call fail while the next succeeds. Coverage: all five cards
  open their pane and mark the shell active, badges are non-empty, a section is
  declared, a blank title is refused with a visible message, the editor refuses
  a draft until a section is picked, the picker routes to the declare form, a
  draft round-trips through the component, two sections keep separate drafts
  (the test that would fail on one shared buffer), a draft survives leaving and
  re-entering the editor, removal empties the outline, a rejected binding
  reaches the status line with the host's wording, a message-less rejection
  falls back to the tool's own, a saved view is restored on boot, and a
  corrupt workspace falls back to the menu instead of hanging.
- **Two harness constraints that were found by failures, and are now documented
  in `docs/testing.md` rather than left as folklore:**
  1. **The loader must be a `--import` preload.** `@vue/runtime-dom` captures
     `document` at import time, so a DOM installed from inside a test body
     arrives too late and every mount dies with "Cannot read properties of null
     (reading 'createElement')" — an error that names Vue, not the cause.
  2. **The DOM must be installed per test file, not in the preload.** A
     process-wide jsdom gave every suite a real `localStorage` and `document`,
     which broke `workspace.test.js`'s "this browser does not allow local
     workspace storage" case and `file-io.test.js`'s anchor-download stub. Both
     were failures, and both are correct: they test the no-host path, so the
     harness is opt-in.
- **Test independence** needed the loader's second job: `boot-state.js` reads
  `localStorage` at import time and the sessions are module singletons, so a
  second test inherited the first one's outline. `openApp()` clears storage
  *before* re-importing `App.vue?fresh=N`, and the loader propagates that token
  through the whole import graph, rebuilding the sessions per test. Without it
  the suite only passes in order, which is how a suite rots.
- **Mutation-checked** (a green test that would also pass on the broken version
  proves nothing): reverting the editor gate to `v-if="false"` fails 4;
  making `createTocItem` accept a blank title fails the refusal test; replacing
  the image viewer's error wording with `'Done.'` fails the fallback test.
  381/381 frontend tests, `npm run check`, `npm run build`, and
  `make smoke-test` (5/5, both render modes) are green.

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

### TODO-022 — Make WebView dependency acquisition immutable — DONE

- **Intent:** I1.3, I3.5, I4.3
- **Priority:** P2
- **Work:** Replace the mutable WebView Git tag dependency in
  `CMakeLists.txt` (`GIT_TAG 0.12.0`) with the immutable commit for that tag,
  and document cache/offline behavior.
- **Done when:** Repeated clean builds resolve the same WebView source and
  first-run network requirements are explicit.
- **Evidence:** `GIT_TAG` is now
  `3ab4b5d722438fc8a13e6ca830c5e2372d19a01d`, the commit the local
  FetchContent clone had already resolved for that tag. The tag is mutable —
  a force-push to it would silently change what a fresh build compiles — while
  the commit is not. Verified two ways rather than assumed: a throwaway
  `FetchContent_Declare` with the SHA and `GIT_SHALLOW TRUE` configured from
  scratch (a shallow clone of a bare commit is not guaranteed to work; GitHub
  allows it and CMake's clone step succeeded), and a clean configure of the
  real `CMakeLists.txt` into a fresh build directory, after which
  `_deps/webview-src` is at the expected commit. The comment above the
  `FetchContent_Declare` records the SHA, why it is a SHA, that the tip is
  still the tagged commit, and the `git ls-remote` command to run when moving
  to a newer release. `docs/development.md` and `README.md` both state the
  pinned commit and the first-run network requirement.

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

### TODO-025 — Audit intent and documentation claims after each slice — DONE

- **Intent:** I0.1, I1.2, I1.3, I4.4
- **Priority:** P1
- **Work:** Remove stale known-gap claims, keep the documentation authoritative
  for the Vue desktop UI, and record test/build evidence for completed items.
- **Done when:** README, intent pyramid, TODOs, architecture docs, and source
  layout describe the same runtime path.
- **Evidence:** the last four Octane references are gone — the `docs/README.md`
  index line, both `docs/overview.md` claims, and the `docs/architecture.md`
  component map, which now names `frontend-vue` and the `window` bindings.
  `rg -i octane` over the tree outside this file returns nothing.
- **Also corrected, beyond the listed items:** every "four tools" claim. The
  workspace has had five since the map landed, and the docs still said four in
  `README.md` (twice), `docs/overview.md` (twice), `docs/frontend.md` (twice),
  `docs/testing.md`, and intent **I1.5**'s own heading and body. The pyramid's
  current-state snapshot was the worst of it: it claimed the frontend "has
  build/format checks but no browser behavior test runner" and that
  "response-buffer truncation ... still require explicit tests", both of which
  TODO-016 and TODO-018 closed. It is rewritten to name the durable store, the
  single test manifest, the smoke test, and the four gaps that are actually
  open (no DOM runner, the map's page-side tile fetch, a mutable WebView tag,
  and `summarize` having no UI caller).
- **Two claims the audit made more honest rather than more flattering:**
  `docs/architecture.md`'s runtime sequence described the user submitting
  comma-separated values into a metrics form that no longer exists, and
  `README.md` advertised `window.summarize` as *the* sample native capability
  with no hint that no production path calls it. Both now say plainly that
  `summarize` survives for the Lua example, the bridge tests, and the smoke
  test. **I1.2** gained the sentence that names the Map Explorer's page-side
  tile fetch as the place the boundary is not held, so the intent reads as a
  standard the project currently misses in one spot rather than as a standard it
  meets everywhere.

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
position and bookmarks live in the shared workspace.

**Status, audited against the tree:** everything except TODO-094 is closed —
090, 091, 092, 093, 095, 096, 097, 098, and 099 are DONE, and 100 is CLOSED
with the reason rather than left open. What remains open in this section is the
one compliance decision, which is not work.

**Still true of the original entries, and unchanged by any of it:** TODO-035,
036, and 041 are the real remaining work for the native half. Nothing here
substitutes for them, and TODO-100 is now explicitly waiting on TODO-036 rather
than racing it.

### TODO-034 — Add the map shell as the fifth grid tool — DONE

- **Intent:** I1.6, I1.5, I2.5
- **Priority:** P1
- **Work:** Add the fifth grid card, the `map` entry in `VIEWS`, and the
  `.map-app` view with a right-hand rail holding four placeholder tools;
  wire badge, status, and the workspace restore path, with
  static-shell and workspace tests.
- **Done when:** The menu shows five cards, the explorer opens and returns to
  the menu, the rail buttons report status, and a restart restores the map
  view.
- **Evidence:** `MenuView.vue:61` is the fifth card and
  `public/index.html:60` mirrors it; `smoke.js` asserts `EXPECTED_MENU_CARDS = 5`
  and requires `.map-app` among its anchors, so the shell's five panes and five
  cards cannot drift apart; `App.vue:1084` renders the pane and the workspace
  restore path is covered by `tests/workspace.test.js`.

### TODO-035 — Build the pure native map layer

- **Intent:** I1.6, I3.3, I4.1
- **Priority:** P1
- **Work:** Add `src/json_mini.c` (strict reader for untrusted responses) and
  `src/map_store.c` (layer table, tile URL building, host allowlist, bounds
  checks, disk-cache read/write/prune, request parsing, response builders)
  with `tests/test_json_mini.c` and `tests/test_map_store.c`, wired into
  `tests/MANIFEST` (which TODO-052 made the single declaration point for a
  suite, so this is one edit rather than three).
- **Done when:** `make test` and `make sanitized-test` cover URL construction,
  allowlist rejections (http, userinfo, suffix spoofing), cache pruning, and
  exact JSON replies without any network access.
- **Note:** `src/json_io.c` already owns the request-string reader and the
  response writer for the rest of the host. This entry's `json_mini.c` is a
  second, untrusted-response reader — the direction the existing codec does not
  face. Before writing it, check whether `json_read_string()` can be extended
  for untrusted input instead, rather than shipping a second JSON grammar
  alongside the one TODO-046 unified.

### TODO-036 — Fetch tiles and places through a native transport

- **Intent:** I1.6, I1.2, I3.3, I3.4
- **Priority:** P1
- **Work:** Add `src/map_session.c`: one persistent worker with a task queue,
  libcurl (https-only, timeouts, size caps, custom User-Agent), the ≥200 ms tile
  rate floor, and the `fetchMapTile` binding; extend the native-bridge helpers to
  forward arguments; wire CURL into the build with `check-curl`. **Tiles only** —
  there is no place search to move, so this entry deliberately does not specify a
  search binding; see TODO-038, which owns that question instead of smuggling it
  in here.
- **Done when:** Warm fetches answer from cache with a `cached` flag, cold
  fetches return a `dataUrl`, and every failure path (offline, HTTP error,
  too large, timeout, unknown layer) returns a typed
  `{error:{code,message}}` — no raw network JSON reaches the page.

### TODO-037 — Render the tile canvas with pan and zoom — DONE

- **Intent:** I1.6, I2.5, I4.1
- **Priority:** P1
- **Work:** Add `map-tiles.js` (pure mercator math: visible tiles, x wrap,
  y clamp, zoom bounds), the tile lifecycle (in-flight dedupe, error tiles,
  LRU), pointer drag pan and wheel zoom in `App.vue`, and the attribution
  footer.
- **Done when:** Tiles render, panning across the antimeridian and clamped
  latitudes stays coherent at every supported zoom, and the math is unit
  tested.
- **Evidence:** the pure math is split across `map-projection.js`,
  `map-canvas.js`, and `map-input.js` (the module names this entry predicted
  are `map-tiles.js` and `map-session.js`; the split is by concern rather than
  by layer, and the projection is renderer-agnostic as intended). Covered by
  `tests/map-canvas.test.js`, `tests/map-explorer.test.js`, and
  `tests/map-places.test.js`. `map-explorer.js:74` documents the zoom-commit
  threshold and `ZOOM_COMMIT_DELAY_MS` the pinch debounce, both exported for
  test.
- **Divergence from the intent, recorded rather than hidden:** tiles render as
  element layers, not data URLs, because nothing is fetching them natively yet
  (TODO-036). Both renderers exist — `.map-tile-layer` and the `<canvas>`
  renderer behind `#map-toggle-renderer` — so TODO-036 is what decides the
  transport, not a rewrite of this layer.

### TODO-038 — Wire the Layers and Search rail tools — REOPENED

- **Intent:** I1.6, I1.2, I4.1
- **Priority:** P1
- **Work:** Layers panel (basemaps, attribution swap, persistence) and search
  panel (debounce, single-flight, stale-response guard, jump to result), each
  with busy, empty, and error status.
- **Done when:** Switching layers re-tiles, search results move the map, and
  every state is distinguishable in the UI and unit tested.
- **What shipped:** the options strip (`#map-filter`, `#map-toggle-renderer`,
  `#map-toggle-grid`, `#map-toggle-cursor`) and its persistence through
  `workspace-persistence.js`. The filter, renderer, grid, and cursor state all
  round-trip a restart, and `MapPane.vue` renders them.
- **What did not ship, and why this entry is reopened rather than closed:**
  **there is no place search in this project.** This entry was previously marked
  `— DONE` with the evidence *"tests/map-explorer.test.js and tests/map-places.test.js
  cover the debounce, the stale-response guard, and the jump."* None of those
  three things exists. `search` appears zero times in `map-explorer.js`,
  `map-viewport.js`, `MapPane.vue`, and `map-places.js`; there is no search input
  in any pane template; and there is no `nominatim` string anywhere in the tree.
  The evidence was written as though the feature had been built and never was.
- **Why that is being treated as a defect rather than a typo.** A `— DONE` marker
  is a promise the next contributor trusts. Fabricated evidence under one is worse
  than an open item, because it does not merely misdescribe the past — it invites
  new work to be built on an assumption that was never tested. It also let the
  error propagate: `PYRAMID-OF-INTENTS.md` I1.6 and `docs/overview.md` both
  describe a search rail, so a reader checking the intent document would have
  concluded the feature shipped.
- **What "layers panel (basemaps)" also does not mean here.** The Explorer has a
  *colour filter*, not a basemap switcher — `#map-filter` restyles one basemap. A
  real basemap switcher is the Google viewer's `#google-map-layer`, which selects
  road, satellite, hybrid, or terrain from a different host. If I1.6's "basemap
  switcher" is meant for the Explorer, that is also open work and belongs here.
- **Search belongs to TODO-036, not to the page.** I1.2 says a tool that reaches
  the network from the page has crossed the boundary without saying so. A geocoder
  is exactly that. So the page-side implementation this entry's evidence described
  could not have been the right one either — it would have been a second
  **I1.2** crossing, which is why the previous divergence note pointed at TODO-036
  while claiming a page-side implementation existed.

### TODO-039 — Wire Locate and bookmarks — PARTIAL

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
- **Shipped (bookmarks):** `workspace.js:216` normalizes `places` with
  `MAX_SAVED_PLACES` as the cap and drops malformed entries; `map-places.js`
  owns add/jump/remove; `workspace-persistence.js` round-trips them, and the
  sidebar's collapsed state persists beside them. `tests/map-places.test.js`
  and the workspace suite cover the schema round-trip. The last center, zoom,
  and layer persist too.
- **Not done (locate):** there is no `locateMapPlace` binding and no GeoClue2
  code anywhere in `src/` or `include/`. The map's search rail offers a
  location query, but nothing reads the system bus. This half needs the native
  host plumbing that TODO-036 introduces, so it is left open deliberately
  rather than split into a new entry — it is the same transport work plus one
  dependency.
- **Cross-reference:** TODO-097 ships locate through `navigator.geolocation` in
  the meantime, behind the same three failure codes this binding will return.
  It does not close this entry, because a browser position is not the same
  guarantee as a system-bus one, but it means the user-facing gap closes before
  the native half does.

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

## Map page audit — declared behavior, untested code, and new capability

These items come out of reading the map implementation against its own
documentation rather than against a feature request. Three of them (090, 091,
092) were cases where the code already promised something and did not deliver
it; two (094, 095) are compliance rather than correctness; one (096) closed a
test gap over code that was already written; and the last three (097, 098, 099)
are new capability that fits the existing data model rather than extending the
boundary.

**Ten are closed — 090, 091, 092, 093, 095, 096, 097, 098, 099 done, 100 closed
as blocked — and only TODO-094 is open. The entry numbers are kept rather than
renumbered,** so a reference to TODO-094 in the evidence below still points where a
reader expects.

**What writing the tests found, which the original entries did not predict.**
Eight of the ten were cases where the code already promised something and did not
deliver it, and every one of them turned out to be sitting on top of a second
defect:

- the rate floor's clock sentinel was wrong for an injected clock starting at zero;
- the GeoJSON overlay was projected at zoom 0 while its ground was placed at the
  tile zoom, so it was thousands of pixels off at any real zoom level;
- the Google URL parser accepted `999,999` as a coordinate and would have
  exported it as a GeoJSON Point;
- `addPlaceFromUrl` reported how many places it had parsed rather than how many it
  had added;
- `normalizeLocation` and the geolocation fix both used `Number()`, so `null`,
  `''` and `[]` became 0 — a record whose latitude had been *cleared* rather than
  deleted became a point on the equator, and a provider reporting a null latitude
  would have centred the map in the Gulf of Guinea;
- the Google viewer never resized its canvas, because `measureMap()` reached for
  the Explorer's canvas id;
- the rate floor existed in one session and was documented as applying to both.

That is the argument for TODO-096's existence more than the missing test files
are. The shared theme is not carelessness: it is that a declared feature nobody
exercised looks exactly like a working one, and every one of these would have
shipped as "the map is blank", "the list is short", or "it is just slow" — never
as a bug report.

**What deliberately is not here:** a native tile proxy, host-side rate limiting,
an on-disk tile cache, and Nominatim reshaping. Those are TODO-035, 036, and
041, and duplicating them page-side would defeat **I1.2**. TODO-095 is the one
entry here that touches the boundary, and it tightens it rather than crossing it:
the tile hosts are named in an `img-src` allowlist while `connect-src` stays
`'self'`, which is what keeps a tile URL from becoming a `fetch()`. That last
constraint is also why TODO-100 is closed rather than done — see its entry, which
is the one place in this section where two correct-looking requirements turned out
to contradict each other.

### TODO-090 — Enforce the tile rate floor the code already declares — DONE

- **Intent:** I1.3, I4.3
- **Priority:** P1
- **Work:** `map-explorer.js:338-345` defines `canFetchTile` and
  `recordTileRequest` and nothing calls them, so the 200 ms floor
  `docs/map-sources.md:17-24` states is documentation rather than behavior.
  Wire both into tile request dispatch, make `DEFAULT_RATE_FLOOR_MS:86`
  overridable so TODO-041 has something to configure, and cover the deferral
  with a test. Same edit retires the two other declared-but-unused map knobs:
  `TILE_RATE_FLOOR_MS` (documented, never read by any code path) and the
  `canvasInputs` computed at `map-explorer.js:216-222`, which is built and
  never returned.
- **Done when:** A second tile request inside the floor is deferred rather than
  issued, the test asserts the deferral rather than the constant, and no map
  module declares a knob that nothing reads.
- **Evidence:** `TILE_BURST` is a token bucket in front of the tile set —
  `admitTiles()` admits centre-outward tiles up to the bucket, and
  `tileSource()` hands an unadmitted tile a transparent pixel instead of a URL,
  so a pending tile never reaches the network. Admission is driven by a
  `watch(mapTiles, …, { flush: 'sync' })` rather than by each place the tile set
  changes (a zoom commit, a resize, the first measurement), because every one of
  those is a way to forget it and a forgotten admission is a map that never
  draws rather than an error. The DOM layer now renders `mapAdmittedTiles`, not
  `mapTiles`: a pending `<img>` holding a transparent pixel fires its load event
  immediately, so the loading indicator would have counted it as arrived ground.
  `canvasInputs` and the dead `canFetchTile`/`recordTileRequest` pair are gone,
  and `TILE_RATE_FLOOR_MS` is documented as never read rather than left
  implying an env var that does nothing. Eight cases in
  `tests/map-explorer.test.js` pin the behavior rather than the constant: the
  first screenful opens at `TILE_BURST`, one more is admitted per interval, the
  bucket refills to its ceiling instead of accumulating, a zero floor disables the
  deferral, the tiles nearest the middle are admitted first, an unadmitted tile
  has no URL, an admitted tile stays admitted across a pan, and dispose releases
  both the timer and the admitted set.
- **A documented number that does not add up, recorded rather than quietly
  fixed:** `docs/map-sources.md:50` derives "~2 requests/second" from a 200 ms
  floor, and 200 ms is 5 per second. The floor is left at 200 ms because it is the
  number already promised in the docs and in the constructor signature, and
  because `TILE_BURST` is what actually bounds a burst; the arithmetic is wrong
  in the document, not in the code. Reconciling the published limit with the OSM
  tile usage policy is TODO-041's job, which is where the policy question
  belongs.
- **Two real bugs found while doing it, both fixed here:**
  `lastTileRequestTime` was initialized to `0`, which on the injected clock the
  tests use (`now: () => clock` starting at 0) reads as "never refilled" forever
  and would have handed out a permanent full bucket; the sentinel is now `null`.
  And the admission timer is `unref()`ed, because in node a pending drain is
  enough to hold a test run open for the length of the whole queue — a 16-second
  test suite before this line, which is the kind of cost that gets "optimized"
  by deleting the test.

### TODO-091 — Persist the Google viewer's state — DONE

- **Intent:** I2.5
- **Priority:** P2
- **Work:** The Explorer persists its view options and the Google viewer does
  not: `workspace-persistence.js:93-100` has no `googleMap` block, and the four
  Google refs listed in the `sessions` object at `App.vue:435-438` are absent
  from the save watcher at `App.vue:472-507`. So the picked layer — road,
  satellite, hybrid, or terrain — is forgotten on restart while the equivalent
  Explorer option survives. Add the snapshot block and the watcher entries,
  keyed off the schema `normalizeGoogleMapSession` at `workspace.js:253-261`
  already validates, and assert the round-trip.
- **Done when:** A restart restores the Google viewer's layer, renderer, grid,
  and cursor state, and a workspace written before this entry (no `googleMap`
  key) still restores without complaint.
- **Evidence:** `snapshot()` gained a `googleMap` block and `apply()` the
  matching restore, both guarded field by field so a workspace written before
  this existed restores rather than failing. It is a separate block rather than
  four more keys on `map` on purpose: these are a different session's options,
  and folding them together would let one workspace hold an Explorer filter and a
  Google renderer under one name with nothing to say which is which. The stored
  layer is validated against `GOOGLE_MAP_LAYERS` rather than passed through, for
  the same reason `MAP_FILTERS` is a closed list — an unrecognized name would
  build a tile URL with no badge or styling for it. `GOOGLE_MAP_LAYERS` and
  `normalizeGoogleMapSession` are now exported from `workspace.js` so the
  validator and the persistence engine read one list.
- **The bug that made this necessary is now covered by a check rather than by
  review:** `tests/workspace-persistence.test.js` already compared the refs
  `snapshot()` reads against the `watch([...])` list in `App.vue`, precisely
  because a ref read by the snapshot but missing from the watcher is silently
  never written. The four Google refs were read by the snapshot and missing from
  the watcher — the exact failure the check exists for, found by the check. Four
  cases cover the block: it is written, it is restored, a workspace with no
  `googleMap` still restores the Explorer, and an unknown layer name is refused.

### TODO-092 — Render GeoJSON on the DOM renderer, or say why not — DONE

- **Intent:** I1.6, I2.2
- **Priority:** P2
- **Work:** The GeoJSON accessor is wired only into the canvas path
  (`map-canvas.js:193`, reached from `map-explorer.js:216-222`), so with
  `#map-toggle-renderer` set to `dom` a loaded layer draws nothing and the UI
  reports success. Either give the DOM path an overlay that does not depend on
  the tile renderer, or disable the toggle while layers are loaded and put the
  reason in the options strip. The first is the better answer; the second is the
  honest one and is much cheaper.
- **Done when:** A loaded FeatureCollection is visible under both renderers, or
  the control that would hide it is unavailable with a stated reason, and a test
  covers the chosen behavior rather than the intent.
- **Evidence:** the first option, and the cheaper fallback turned out to be
  unnecessary once the conversion was extracted. New `src/map-geojson-view.js`
  turns layers plus a layer transform into `{ circles, paths }` in viewport
  pixels, and both renderers draw those: `map-canvas.js` walks them into a 2D
  context and `App.vue` renders them as an `<svg>` overlay. The renderer toggle
  now chooses only how the *tiles* are drawn, so a loaded layer is visible either
  way. The session computes the shapes once (`geojsonShapesFor`) and the canvas
  is handed that same value, because two derivations of one geometry is the drift
  this was meant to remove.
- **Two bugs fixed on the way, both of which had the overlay in the wrong place
  at any zoom but one:** `map-canvas.js` projected with a hardcoded zoom 0 while
  the tile layer's children are positioned at the *tile* zoom, which agrees at
  scale 1 and is thousands of pixels wrong everywhere else — so the canvas
  overlay was misplaced whenever `tileZoom` was not 0. It also inlined its own
  copies of `lonToTileX`/`latToTileY`; those now come from `map-projection.js`.
  The new `tests/map-geojson.test.js` pins the projection at a known view, so a
  repeat of that is a failing number rather than a shrug.
- **`preserveAspectRatio="none"` is load-bearing and is commented as such:**
  without it the browser letterboxes the `viewBox` to its own aspect ratio and
  the overlay drifts off the ground beneath it — the same class of silent
  half-tile error the projection bug was.

### TODO-096 — Cover the untested half of the map — DONE

- **Intent:** I4.1
- **Priority:** P1
- **Work:** There is no `tests/google-maps-session.test.js`, and nothing in
  `tests/` mentions GeoJSON, so two pure, dependency-injected surfaces are
  untested: `parseGoogleMapsUrl` (`google-maps-session.js:603-684`, five URL
  shapes including the two that yield no coordinates at all) and
  `loadGeoJSON` (`map-explorer.js:1084-1111`, which validates a
  FeatureCollection and can reject). Both factories already accept injected
  `doc` and `FileReader`-free inputs, so this is test-shaped work, not
  refactoring.
- **Done when:** Every URL shape in the parser has a case including the
  coordinate-less ones, a malformed FeatureCollection is rejected with a
  message rather than a throw, and `npm test` fails if either function is
  deleted.
- **Evidence:** `tests/google-maps-session.test.js` (22 cases) and
  `tests/map-geojson.test.js` (19 cases), 41 in all. `parseGoogleMapsUrl` was
  hoisted out of the session to module scope first: it is pure, it reads a string,
  it touches no state, and hoisting it is what makes "exercised without a
  session" true rather than incidental. Its cases pin all five shapes, the two
  that yield no coordinates, the precedence between nested patterns, and the
  generated name for a coordinate with no label. The GeoJSON cases pin the
  FeatureCollection and bare-Feature forms, all three rejection paths, the
  visibility toggles, and that both renderers are handed the identical shapes.
- **Two defects the new tests found, both fixed:**
  - **The parser accepted impossible coordinates.** The patterns match `999,999`
    happily and those places are exported as GeoJSON Points, so an out-of-range
    value produced a file other tools reject — long after the moment it was
    cheapest to refuse. `usableCoordinate()` now bounds both axes. Longitude is
    bounded rather than wrapped on purpose: a URL is not a projection, and quietly
    turning 999 into -1 would invent a location.
  - **`addPlaceFromUrl` reported a count it had not applied.** It reported
    `Added N places` where N was the number parsed, even when all of them were
    duplicates and none were added. The message now counts what the list gained,
    so re-adding a URL says so rather than claiming a place that is not there.
- **`loadGeoJSON` needed one seam, not a refactor:** it takes a `File` and reads
  it as text, so the tests install a `FileReader` stand-in and drive the loader's
  own parsing and rejection paths rather than the browser's file reading.

### TODO-095 — Ship a Content-Security-Policy that names the tile hosts — DONE

- **Intent:** I1.2, I4.3
- **Priority:** P2
- **Work:** `docs/map-sources.md:11-13` and `:69-71` list an allowlist of tile
  hosts, and nothing enforces it — `dist/index.html` ships no
  `Content-Security-Policy` at all, so any origin the page reaches is
  reachable. Emit a CSP whose `img-src` is limited to the configured tile hosts
  and whose `connect-src` matches whatever TODO-036 ends up needing.
- **Done when:** A tile host outside the allowlist is blocked, the map still
  renders from the allowlisted ones, and the policy is emitted with the built
  artifact rather than described in a document.
- **Evidence:** `src/csp.js` holds the policy and is injected by
  `plugins/single-file-html.js` into `<head>` of `dist/index.html`. Verified in
  the built artifact:
  `img-src 'self' data: blob: tile.openstreetmap.org mt1.google.com`, with
  `connect-src 'self'` and no third-party host in it — which is the useful part,
  since the map fetches tiles through `<img>` and a host in `connect-src` would
  mean something had started calling `fetch()` on a third party, the crossing
  I1.2 exists to prevent. `default-src 'self'`, `frame-src`/`object-src`/`base-uri`
  `'none'`.
- **Generated rather than typed, because a typed list drifts.** `TILE_HOSTS` is
  exported from `csp.js` and is the single place both the policy and the test read
  from; the policy is built from it at build time, so adding a tile source to a
  session fails `tests/csp.test.js` until someone decides whether it should be
  reachable. That is the moment to decide, rather than after it has been.
- **script-src carries a hash, and the reason is recorded rather than papered
  over.** The build inlines the whole bundle into one `<script>`, so
  `script-src 'self'` alone blocks the only script there is and the app never
  starts — an unsatisfiable policy, which is worse than none. The plugin hashes
  the inline bodies and `tests/csp.test.js` recomputes the hash from
  `dist/index.html` and fails if it does not match, so a change to the plugin's
  hashing fails in the test suite rather than in the desktop host. PDF.js needs to
  compile its decoders, so `'wasm-unsafe-eval'` is allowed instead of the broader
  `'unsafe-eval'`.
- **Two limits stated instead of implied away.** `style-src` keeps
  `'unsafe-inline'`, because Vue writes `style` attributes at runtime for the tile
  transforms and marker positions and those are not in the built document to be
  hashed — so an injected style attribute can still apply. And a `<meta>` policy
  is weaker than a header: it cannot carry `frame-ancestors`, and it does not
  govern requests made before it is parsed. It ships as a meta tag because that
  is the only form that survives being inlined into the single self-contained HTML
  file the desktop host loads.
- **TODO-094 is not resolved by this.** `mt1.google.com` is in the allowlist
  because it is in the code. Naming it in a policy is not a licence, and the entry
  says so where the constant is defined.

### TODO-093 — Extract one map viewport out of the two sessions — DONE

- **Intent:** I4.4, I4.1
- **Priority:** P3
- **Work:** Pan, zoom, inertia, pointer and keyboard handling, measurement, the
  resize observer, and tile loading are near-verbatim between
  `map-explorer.js` and `google-maps-session.js` — roughly 300 lines, and the
  two copies have already drifted (pins, filters, and `flyTo` on one side; a
  layer ref on the other). Extract a `createMapViewport()` core that both
  sessions compose, following the factory pattern they already use, and delete
  the two `lonToTileX`/`latToTileY` copies that `map-canvas.js:233-241`
  duplicates from `map-projection.js`. Same edit drops the orphaned
  `.map-canvas.flying` rule at `index.css:1885`, which no template or class
  binding applies.
- **Done when:** The pan/zoom/measure/observer logic exists once, both viewers
  still pass their suites, and a fix to the core reaches both viewers without a
  second edit.
- **Evidence:** new `src/map-viewport.js` (1010 lines) owns the shared half, and
  the two sessions compose it: `map-explorer.js` 1580 → 708 lines,
  `google-maps-session.js` 908 → 401. The duplication was measured before the
  edit, not estimated: 32 shared function names, ~476 lines of overlap. Both
  sessions keep their own surface and spread the viewport in rather than
  re-listing forty names by hand — a name added to the viewport and not to a
  session's export list is the drift this exists to prevent, and the spread makes
  that a non-event.
- **The drift this was supposed to fix was already costing something concrete.**
  The rate floor from TODO-090 existed only in `map-explorer.js`, while
  `docs/map-sources.md` listed a 200 ms floor for the Google viewer too. The
  Google viewer was fetching as fast as the DOM asked. It now inherits the
  bucket, and that documented lie is closed.
- **What makes "render-only" survive an extraction that could have blurred it:**
  three optional hooks rather than capability flags threaded through the gesture
  code. `onClick` (the Explorer drops a pin; the Google viewer has none),
  `onInterrupt` (only the Explorer has a flight to cancel), and `onViewMoved`.
  A missing hook is a no-op, so "this viewer has no pins" costs three absent
  properties rather than a dozen `if (hasPins)` branches.
- **Two defects found and fixed by the extraction, both invisible before it:**
  - **The default tile URL had been losing its interpolations.** biome flagged
    `x` and `y` as unused parameters on `DEFAULT_TILE_URL`, which is only
    possible when `{x}` and `{y}` are literal text in a template literal rather
    than `${x}` and `${y}` — a URL of `.../12/{x}/{y}.png`, which 404s at every
    zoom level and reads as "the map is blank" rather than as a typo. It was
    introduced during this edit and caught before it shipped; the constant now
    carries a comment saying so, because the failure mode is invisible.
  - **The Google viewer never resized its canvas.** `measureMap()` reached for
    `#map-canvas-surface` unconditionally, which is the *Explorer's* canvas id,
    so the Google canvas backing store was never sized to its pane. `canvasSelector`
    is now a viewport option and each session names its own.
- **`mapLoading` is measured against the wanted tile set, not the admitted one.**
  An earlier version of the viewport compared against admitted tiles, which made
  the flag go false with half the screen still queued behind the rate floor — and
  the outgoing-layer retirement keys off it, so the backdrop was being pulled out
  from under a half-drawn map. Caught by the existing
  "the outgoing layer is kept until the incoming tiles have all arrived" case,
  which is the sort of thing the entry's own "both viewers still pass their
  suites" clause exists to catch.
- **The orphaned `.map-canvas.flying` rule was bound rather than deleted.** The
  state it was waiting for now lives in the shared viewport, so `mapFlying` is
  bound to the canvas class and the rule works. Its comment was right: during a
  flight the map is being driven, not dragged, so a grab cursor is a lie.
- **The duplicated `lonToTileX`/`latToTileY` in `map-canvas.js` were already gone**
  — TODO-092 extracted them into `map-geojson-view.js` while making the overlay
  renderer-independent. Recorded here because this entry predicted that work.

- **Intent:** I4.4, I4.1
- **Priority:** P3
- **Work:** Pan, zoom, inertia, pointer and keyboard handling, measurement, the
  resize observer, and tile loading are near-verbatim between
  `map-explorer.js` and `google-maps-session.js` — roughly 300 lines, and the
  two copies have already drifted (pins, filters, and `flyTo` on one side; a
  layer ref on the other). Extract a `createMapViewport()` core that both
  sessions compose, following the factory pattern they already use, and delete
  the two `lonToTileX`/`latToTileY` copies that `map-canvas.js:233-241`
  duplicates from `map-projection.js`. Same edit drops the orphaned
  `.map-canvas.flying` rule at `index.css:1885`, which no template or class
  binding applies.
- **Done when:** The pan/zoom/measure/observer logic exists once, both viewers
  still pass their suites, and a fix to the core reaches both viewers without a
  second edit.

### TODO-094 — Decide what the Google tile endpoint is

- **Intent:** I4.3, I3.5
- **Priority:** P1
- **Work:** `google-maps-session.js:44-48` builds
  `https://mt1.google.com/vt/lyrs=...&x=..&y=..&z=..`, Google's internal raster
  endpoint, used with no API key and no Maps Platform licence, which
  contradicts `docs/map-sources.md:26-37` and `:87-91`. Three honest options:
  drop the Google viewer and leave OSM as the one tile source; move the tile URL
  into configuration so no unlicensed endpoint is compiled in; or keep it behind
  an explicit opt-in that states the policy in the UI. Whichever is chosen, the
  other two must be recorded as rejected rather than left unmentioned, because
  the current state is the one option that is not defensible.
- **Done when:** The tree either no longer names an unlicensed endpoint or
  requires a deliberate user choice before contacting it, and
  `docs/map-sources.md` says which.

### TODO-097 — Locate from the browser API now, behind the binding's interface — DONE

- **Intent:** I1.6, I3.4
- **Priority:** P2
- **Work:** The locate half of TODO-039 is blocked on libcurl and GeoClue2, but
  `navigator.geolocation` needs no native code. Wire it with a bounded wait and
  the same three failure codes the future binding will return —
  `LOCATE_UNAVAILABLE`, `LOCATE_DENIED`, `LOCATE_TIMEOUT` — surfaced through the
  existing `setMapStatus` path. Structure it so `locateMapPlace` replaces the
  implementation behind the interface rather than beside it.
- **Done when:** Locate centers the map where the browser exposes a position,
  each of the three failures reaches the status line with its own wording, and
  swapping in the native binding is a one-function change.
- **Evidence:** `src/map-locate.js` returns exactly the three codes TODO-039
  specifies, with the same meanings, and `App.vue`'s `locateMapPlace()` prefers
  `getNativeBinding('locateMapPlace')` when the host provides one and falls back
  to `locateViaBrowser()` otherwise. Swapping the transport is a change to that
  one function, not a rewrite of the status line or the button. Nine cases in
  `tests/geo-locate.test.js` drive all four paths with injected geolocation and
  manual timers, so no case waits twelve seconds for a timeout.
- **A fourth case the specification does not name, decided rather than left to
  chance:** a fix that arrives carrying no usable coordinate is reported as
  `LOCATE_UNAVAILABLE`. It is not dropped and it is not turned into 0,0.
- **A real bug the tests found, of exactly that kind:** the coordinate check was
  `Number(coords?.latitude)`, and `Number(null)`, `Number('')` and `Number([])`
  are all 0 — so a provider reporting a null latitude would have centred the map
  in the Gulf of Guinea with no error anywhere. The check is now a `typeof`
  test. The same shape of bug was then found in `geo.js` (see TODO-099).
- **This does not close TODO-039, and says so where a reader will look.** A
  browser position is not a system-bus one: on a desktop it is often city-level
  or absent. The reported accuracy is passed through to the status line
  unrounded rather than being hidden behind six decimal places of confidence the
  device does not have, and the module's header says the guarantee is weaker.

- **Intent:** I1.6, I3.4
- **Priority:** P2
- **Work:** The locate half of TODO-039 is blocked on libcurl and GeoClue2, but
  `navigator.geolocation` needs no native code. Wire it with a bounded wait and
  the same three failure codes the future binding will return —
  `LOCATE_UNAVAILABLE`, `LOCATE_DENIED`, `LOCATE_TIMEOUT` — surfaced through the
  existing `setMapStatus` path. Structure it so `locateMapPlace` replaces the
  implementation behind the interface rather than beside it.
- **Done when:** Locate centers the map where the browser exposes a position,
  each of the three failures reaches the status line with its own wording, and
  swapping in the native binding is a one-function change.

### TODO-098 — Measure distance and bearing between places — DONE

- **Intent:** I1.6, I2.3
- **Priority:** P3
- **Work:** Places are a persisted, capped, deduplicated list and no
  point-to-point math exists anywhere — `map-projection.js:229-263` has
  `metersPerPixel` and a scale bar, which are not the same question. Add
  haversine distance and initial bearing to `geo.js`, then show the distance
  from the cursor to the selected place in the cursor readout and the distance
  between the two most recently used places in the sidebar.
- **Done when:** Both numbers are correct against a known pair to within a
  stated tolerance, they read as rounded metric with an imperial option beside
  the existing scale bar, and the math is unit tested in `geo.js`'s own terms.
- **Evidence:** `distanceMeters`, `bearingDegrees`, `formatDistance`,
  `formatDistanceImperial`, and `compassPoint` in `geo.js`. Haversine rather
  than the spherical law of cosines, because the latter throws away most of its
  digits for two nearby points — which is the common case here, since the
  distances on screen are between pins a few streets apart. `asin` is fed a
  clamped argument for the antipodal case, where `sin²` can come back as
  1.0000000000000002 and the answer would otherwise be NaN. The bearing handles
  the antimeridian, where a naive longitude difference sends the reader west
  around the planet instead of east.
- **Two places in the UI, answering two different questions:** the cursor readout
  gains bearing and distance to the *selected* place (opened in the sidebar or by
  clicking its marker), and the sidebar gains the leg distance between each pair
  of consecutive places. The leg distances are memoised on the coordinate pair,
  because the list re-renders on every pointer move while the readout is live and
  measuring two hundred haversines per frame is work nobody asked for.
- **A reference value in the test was wrong, and the distinction matters:** one
  degree of latitude is 111,195 m on a sphere of radius 6,371,008.8 m and
  110,574 m on the WGS-84 ellipsoid. The 0.5% between them is the model's stated
  cost and `geo.js` says which one it is; using the ellipsoid figure as the test's
  expectation would have been a plausible-looking wrong number rather than a
  useful one, so the test now says which is which.

- **Intent:** I1.6, I2.3
- **Priority:** P3
- **Work:** Places are a persisted, capped, deduplicated list and no
  point-to-point math exists anywhere — `map-projection.js:229-263` has
  `metersPerPixel` and a scale bar, which are not the same question. Add
  haversine distance and initial bearing to `geo.js`, then show the distance
  from the cursor to the selected place in the cursor readout and the distance
  between the two most recently used places in the sidebar.
- **Done when:** Both numbers are correct against a known pair to within a
  stated tolerance, they read as rounded metric with an imperial option beside
  the existing scale bar, and the math is unit tested in `geo.js`'s own terms.

### TODO-099 — Import places from a GeoJSON or CSV file — DONE

- **Intent:** I1.6, I2.5
- **Priority:** P3
- **Work:** Places can only be added one click at a time
  (`map-places.js:60-114`), which does not scale past a handful. The loader
  already parses FeatureCollections at `map-explorer.js:1084-1111`; extend it to
  bulk-create places from Point features, reusing the existing dedupe by
  coordinate (`:73-82`) and `MAX_SAVED_PLACES` cap (`:83-89`) rather than a
  second set of rules, and report skipped and over-cap rows.
- **Done when:** A file of Point features becomes saved places in one action,
  a file with mixed or invalid geometry is partly accepted with a count of what
  was skipped, and re-importing the same file adds nothing.
- **Evidence:** `src/map-places-import.js` reads GeoJSON and CSV, and
  `addPlaces()` on the places session writes the result. The sidebar gains an
  `Import` control beside `Save pin` and `Clear`; it is separate from the GeoJSON
  *layer* loader on purpose, because the two are different operations — a layer is
  drawn and discarded, these persist and can be attached to an outline section.
- **No second set of rules.** `addPlaces()` folds through the same
  `normalizeLocation`, the same coordinate dedupe, the same label cap, and the
  same `MAX_SAVED_PLACES` that `addPlace()` uses. It also commits once rather
  than per row: routing two hundred rows through `addPlace()` would write the
  whole workspace per row and set a status message per row, of which only the
  last would ever be read.
- **The cases that matter are the wrong ones, and they are the ones tested.** A
  CSV's lat/lon columns are found by *name*, never by position: `lon,lat` is at
  least as common as `lat,lon`, and reading it the wrong way round produces a
  list of plausible places in the wrong hemisphere with no error and no empty
  map. A file with no coordinate columns is refused rather than guessed at. The
  CSV splitter is hand-written because a name containing a comma — "Gate, North"
  — breaks `split(',')` and puts the coordinates in the wrong columns. GeoJSON
  `coordinates` are `[lon, lat]`, the reverse of the `{lat, lon}` used
  everywhere else in the app.
- **No geocoding, deliberately.** A row with a name and no coordinate cannot be
  resolved, and inventing a position would put a pin somewhere the file never
  claimed; such rows are counted and reported. A Point feature with *no name* is
  the opposite case and is kept, labelled from its own coordinates — the reader
  asked for that location, and `addPlace()` would have invented exactly that
  label. Non-Point features are skipped rather than having their first vertex
  taken: that would be a guess, and drawing the layer is a different operation.
- **Two bugs the tests found, both of the same kind as TODO-097's:**
  `normalizeLocation` used `Number()`, so `null`, `''`, `[]` and `true` all
  became 0 or 1 — a record whose latitude had been *cleared* rather than deleted
  became a point on the equator off Ghana, and could not be spotted by looking at
  the map. It now accepts a number or a non-empty numeric string and nothing
  else, which is what its own comment claimed it did.

- **Intent:** I1.6, I2.5
- **Priority:** P3
- **Work:** Places can only be added one click at a time
  (`map-places.js:60-114`), which does not scale past a handful. The loader
  already parses FeatureCollections at `map-explorer.js:1084-1111`; extend it to
  bulk-create places from Point features, reusing the existing dedupe by
  coordinate (`:73-82`) and `MAX_SAVED_PLACES` cap (`:83-89`) rather than a
  second set of rules, and report skipped and over-cap rows.
- **Done when:** A file of Point features becomes saved places in one action,
  a file with mixed or invalid geometry is partly accepted with a count of what
  was skipped, and re-importing the same file adds nothing.

### TODO-100 — Cache tiles on the page so repeat visits do not refetch — CLOSED

- **Intent:** I2.5, I4.4
- **Priority:** P3
- **Work:** Caching is memory-only and pruned to about twice the live tile
  count (`map-canvas.js:60-84`), so every restart and most pans refetch tiles
  the user has already seen. Add a small bounded LRU in `localStorage` keyed by
  tile URL with an explicit byte budget and eviction, and keep it entirely
  page-side. This is deliberately *not* the disk cache in TODO-041: that one
  belongs behind the native binding, and building it twice would put two caches
  in the path with one of them unreachable.
- **Evidence:** not shipped, and the module was written and then deleted rather
  than left in place unwired. The reason is a conflict between this entry's own
  constraints, found while building it:
  - Tiles reach the page as `<img src>`, so there are no bytes to cache. Putting
    them in a cache means fetching them with `fetch()` instead, which needs the
    tile hosts in **`connect-src`** — and `src/csp.js` deliberately keeps that at
    `'self'`, with a case in `tests/csp.test.js` asserting no tile host appears
    there. The reasoning is written down: a third-party host in `connect-src`
    means something has started calling `fetch()` against a third party, which is
    exactly the crossing **I1.2** exists to prevent.
  - The alternative, reading the pixels back out of a cross-origin `<img>` and
    encoding them, taints a canvas and throws.
  - So the only two ways to populate a page-side cache are to cross **I1.2**
    page-side, or to wait for TODO-036's native binding — which is where this
    entry's own text says the disk cache belongs.
  **Closing it rather than leaving it open, because it is not work waiting to be
  done: it is work waiting on a decision.** If TODO-094 or TODO-036 moves tile
  fetching behind the host, the cache comes back for free there, with the disk
  cache TODO-041 already plans. Shipping a page-side cache first would mean two
  caches in the path, one of them unreachable — the precise outcome this entry
  was written to avoid.

- **Intent:** I2.5, I4.4
- **Priority:** P3
- **Work:** Tile caching is memory-only and pruned to about twice the live tile
  count (`map-canvas.js:60-84`), so every restart and most pans refetch tiles
  the user has already seen. Add a small bounded LRU in `localStorage` keyed by
  tile URL with an explicit byte budget and eviction, and keep it entirely
  page-side. This is deliberately *not* the disk cache in TODO-041: that one
  belongs behind the native binding, and building it twice would put two caches
  in the path with one of them unreachable.
- **Done when:** A second visit to an area renders from cache without network
  requests, the budget is enforced and reported in the status line, and a
  corrupted cache entry is dropped rather than thrown.

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
- **Update (TODO-017 landed):** App.vue is 1428 lines, and the per-pane
  extraction is now unblocked in the way this entry predicted — the DOM harness
  mounts the real component, so a template of that size is covered by 14 tests
  that click through it rather than by the 5-check smoke run alone. The
  remaining argument against the split (prop plumbing across 10-20 session
  bindings per pane) is unchanged, and the harness's `?fresh=N` reload trick
  means a new pane component can be mounted in isolation without the whole
  graph. What is still missing for this entry is the `<StatusLine>` merge of the
  four remaining hand-written status spans, and the duplicated outline
  `<select>`.

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

## Responsive layout — making the grid menus usable off a desktop window

These items implement **I1.5** and **I2.1** for a narrow viewport, and record
the platform assumptions behind **I4.3**. They come from a full audit of every
`display: grid` in `frontend-vue/src/index.css`, of which five are real
multi-column layouts: `.app-grid` (the five-card menu), `.image-grid`
(thumbnails), `.pdf-app`, `.image-app`, and `.map-app`. The other ~40 grid rules
are single-column stacks used only for `gap`, so they are out of scope.

The audit found the following, each numbered as the evidence in the item that
addresses it:

- **F1** — `.app-grid`'s single-column rule is `minmax(0, 330px)` and
  `.app-menu` drops to `16px` side padding, so the grid needs **362px** while
  `body` is allowed down to `min-width: 320px`. A 320–361px phone gets a
  horizontally scrolling menu.
- **F2** — five cards at `min-height: 112px` plus gaps is 632px, and with the
  heading and padding roughly **866px** total, taller than any phone viewport
  (iPhone SE is 667px). The 112px card and 58×72 icon are desktop density.
- **F3** — `.map-app` overlays its sidebar below 900px
  (`index.css:2022-2039`), but `.pdf-app` and `.image-app` only shrink the
  column to 165px/145px, leaving a 360px phone a **195px** reader canvas.
- **F4** — touch targets are below 44px: `.toolbar-button` computes to
  **30.8px** (29.6px at the 700px tier — it shrinks on mobile), `.lightbox-nav`
  38px, selects 34–39px. Only `.app-card` (112px) passes.
- **F5** — 15 `100vh` usages and no `dvh`/`svh`, so panes sized
  `calc(100vh - 72px)` are clipped by a collapsing mobile URL bar.
- **F6** — no `env(safe-area-inset-*)`; the 72px `.launcher-header` and 56px
  `.topbar` sit under a notch and home indicator in landscape.
- **F7** — ~20 `:hover` rules with no `@media (hover: hover)` guard, so
  `.app-card`'s `translateY(-1px)` sticks after a tap.
- **F8** — `<700px` is a cliff: 320px and 690px get identical layouts, and the
  2-column tier needs 710px with no slack.
- **F9** — `public/index.html:27-68` duplicates `.app-grid` and its five cards
  for the pre-Vue paint, enforced by `tests/static-shell.test.js:360-368`; the
  card order already differs between the two (static shell is editor-first,
  `MenuView.vue` is toc-first).
- **F10** — no test asserts any `grid-template-columns` value or breakpoint;
  `tests/static-shell.test.js:384-403` checks only the overflow/ellipsis rules.

### TODO-054 — Stop the menu grid from overflowing a narrow phone — DONE

- **Intent:** I1.5, I2.1, I4.3
- **Priority:** P1
- **Work:** Replace `.app-grid`'s fixed `minmax(0, 330px)` single-column track
  with one that cannot exceed its container, and move the column cap to a
  `max-width` on the grid itself so the intent ("cards are at most this wide")
  is expressed once.
- **Done when:** `.app-grid` needs no more viewport width than the
  `.app-menu` content box at every width from `body`'s `min-width: 320px`
  upward, and the four tiers still land 5 / 3 / 2 / 1 columns.
- **Evidence:** every `.app-grid` tier is now `1fr` tracks plus a `max-width`
  (1322px / 936px / 678px / 330px, the first three being exactly the old
  `repeat(n, minmax(0, Npx))` widths including gaps), so the grid's width is
  `min(container, cap)` at every width and the 362px-against-320px overflow is
  unrepresentable rather than merely tuned around. The single-column tier also
  tightens its gap 18px → 12px. Locked by two tests in
  `tests/responsive-layout.test.js`, both of which were confirmed to fail
  against a reverted `minmax(0, 330px)`.
- **Note:** the `480px` breakpoint originally planned here moved to TODO-058,
  which is the item that gives the sub-700px range a denser card anyway.

### TODO-055 — Size panes against the real mobile viewport — DONE

- **Intent:** I4.3
- **Priority:** P1
- **Work:** Add a `--viewport-h` custom property defined as `100vh` with a
  `100dvh` override, and route all 15 `100vh` usages through it, so a
  collapsing URL bar no longer clips the status bar or toolbar of a
  full-height pane. Apply `env(safe-area-inset-*)` padding to
  `.launcher-header` and `.topbar` so neither sits under a notch or home
  indicator in landscape.
- **Done when:** no `100vh` remains outside the custom property's own fallback
  definition, and both bars pad themselves by the device insets.
- **Evidence:** `--viewport-h` is `100vh` with a `@supports (height: 100dvh)`
  override, and all 15 usages now read it — the six full-height panes
  (`.editor-app`, `.app-menu`, `.toc-manager`, `.pdf-app`, `.image-app`,
  `.map-app`), the two `100vh` app-shell heights, the image-active and
  pdf-active `calc(… - 48px)` variants, and the two capped overlays
  (`.recent-paths-list`, `.lightbox img`). The insets are read once into
  `--topbar-safe-top`/`--topbar-safe-bottom` under `@media (pointer: coarse)`
  and consumed by both bars. One consequence the audit had not anticipated:
  `.editor-app`'s first grid row was the literal `56px` while `.topbar` now adds
  the insets to its own 56px, so the bar would have overflowed its track — both
  now read a shared `--topbar-h`, which the pane `calc`s can no longer drift
  from. Four tests in `tests/responsive-layout.test.js` cover it, two of them
  confirmed to fail against a reintroduced `calc(100vh - 72px)` and a dropped
  `env()` inset.

### TODO-056 — Lock the responsive layout with a test — DONE

- **Intent:** I4.1
- **Priority:** P1
- **Work:** Add `frontend-vue/tests/responsive-layout.test.js` asserting the
  breakpoint-to-column mapping for the five real grids and the arithmetic that
  decides whether a fixed track can overflow the narrowest supported viewport.
- **Done when:** changing a column count or a breakpoint without updating the
  intent fails `npm test`, and F1 cannot regress silently.
- **Evidence:** 7 tests. They parse `index.css` with a small brace-matching
  walk rather than regexing blocks, because the sheet argues its layout
  decisions in prose and several comments contain both a brace and a media
  query; comments are stripped first, preserving line offsets. Coverage: the
  5/3/2/1 mapping keyed by media query; no fixed track on the five grids
  exceeding `body`'s 320px floor; `.app-grid` carrying no pixel-sized track and
  a `max-width` rather than a `width`; the `--viewport-h` token's fallback,
  its `dvh` override, its 12 consumers, and the absence of a stray `100vh`; the
  two bars' insets; and `--topbar-h` shared by `.editor-app` and `.topbar`.
  Mutation-checked: reverting F1 to `minmax(0, 330px)` fails 2, reintroducing
  `calc(100vh - 72px)` in `.map-app` fails 1, and dropping the `.topbar` inset
  fails 1. 362/362 frontend tests, `npm run check`, `npm run build`, and
  `make smoke-test` (5/5, both render modes) are green.

### TODO-057 — Meet the 44px touch target on coarse pointers — DONE

- **Intent:** I2.1, I1.5
- **Priority:** P2
- **Work:** Add a `@media (pointer: coarse)` block raising every interactive
  control to at least 44px, and stop the `700px` tier from shrinking
  `.toolbar-button` further.
- **Done when:** every interactive control is at least 44×44px under
  `pointer: coarse`, and the pointer-fine layout is unchanged.
- **Evidence:** one `@media (pointer: coarse)` block covering `.toolbar-button`
  (30.8px), the outline row's three 28px square buttons,
  `.workspace-report-dismiss`, `.lightbox-close`/`.lightbox-nav` (38px at the
  narrow tier), `.map-place-action` (~20px), `.toc-outline-link`/`.toc-item`
  (which had 3px of padding and no height of their own), the folder list
  buttons, the remembered-path buttons, and the seven form fields — which are
  also lifted from `0.85rem` to `1rem`, because below 16px iOS Safari zooms the
  viewport on focus and does not zoom back. Keyed on the pointer, not the
  width, so a narrow desktop window keeps the dense layout. The floor is
  `min-height`, never a padding change on the control itself, so a longer label
  still grows rather than reflowing the toolbar; the block pads the three
  *containers* instead, which is what gives the newly-tall button somewhere to
  sit. Two tests in `tests/responsive-layout.test.js` cover it, mutation-checked
  against dropping `.toolbar-button` from the block (fails), lowering the
  outline buttons to 40px (fails), reverting the form fields to `0.85rem`
  (fails), and adding a `min-height: 30px` to the narrow tier that would defeat
  the floor (fails).

### TODO-058 — Give the menu a phone-scale density — DONE

- **Intent:** I1.5
- **Priority:** P2
- **Work:** Add a `480px` breakpoint that turns the menu from a scaled-down
  desktop grid into a phone list: shorter cards, a smaller icon that shrinks
  with them, and a tighter heading and grid gap.
- **Done when:** all five tools are reachable without scrolling on an iPhone SE
  viewport, and no card's badge is clipped at the new density.
- **Evidence:** the card is 76px (from 112px) on a 44px icon (from 58×72), with
  the icon track and both gaps reduced to match — at 44px and 12px gaps a 288px
  phone column still leaves room for an unclipped 1rem title, where the old
  58px/16px pair left only ~148px of copy. The card stack is 428px (from 632px)
  and the whole menu ~583px against a 595px budget (667px viewport less the
  72px header), so all five fit where the fifth previously sat 199px below the
  fold. The badge keeps its two-line clamp, because the card is a fixed height
  and an unclamped third line would push the arrow out of it. The test measures
  the sheet's own numbers rather than estimating them — the eyebrow, the h1's
  `clamp` floor, the paragraph, and the margins all come from the CSS — and is
  mutation-checked against restoring the 112px card, deleting the tier, and
  growing the badge font.

### TODO-059 — Stop hover effects from sticking after a tap — DONE

- **Intent:** I2.1
- **Priority:** P3
- **Work:** Wrap the `:hover` rules in `@media (hover: hover)`, and pair each
  with a `:focus-visible` or `.active` rule so keyboard and state affordances
  survive.
- **Done when:** hover styling applies only on hover-capable pointers, and
  every element that had a hover style still has a non-hover equivalent.
- **Evidence:** all 16 hover rules are now inside `@media (hover: hover)`. The
  three that grouped `:hover` with `:focus-visible` and `.active` were split
  rather than moved, so the state styling is unconditional and only the hover
  half moved — `.app-card`, `.toc-outline-item`, `.toc-item`,
  `.image-group-button`, `.image-thumbnail`, `.map-place-marker`, and the
  lightbox arrows. Two controls had a hover style and no keyboard equivalent at
  all (`.toc-outline-link`, `.map-place-action`); both gained a
  `:focus-visible` rule with the same colour change plus an outline. The test
  asserts both halves — no unguarded `:hover` rule, and no hover target without
  a non-hover affordance — and is mutation-checked against un-guard the
  `.app-card` lift and against deleting the `.toc-outline-link` focus ring.

### TODO-060 — Give the reader and viewer the map's overlay sidebar — DONE

- **Intent:** I1.5, I2.1
- **Priority:** P2
- **Work:** Apply the `.map-app` pattern to `.pdf-app` and `.image-app` below
  the 700px breakpoint, with a collapsed flag in the session factories
  mirroring `mapSidebarOpen`.
- **Done when:** at 360px the reader canvas and the thumbnail grid use the full
  width, the sidebar is reachable and dismissible, and it does not unmount.
- **Evidence:** `pdfSidebarOpen`/`togglePdfSidebar` and
  `imageSidebarOpen`/`toggleImageSidebar` are in `pdf-session.js` and
  `image-session.js` as factory members, so an isolated session in
  `tests/session-factories.test.js` has its own flag; the 145px and 165px
  narrow-tier columns are gone and both shells go to a single column with the
  panel as an overlay `min(280px, 82vw)` wide — a fixed 280px leaves only 40px
  of backdrop on a 320px phone, which is too little to tap to dismiss. The
  panel is `display:none` when closed *below* the breakpoint and
  `visibility:hidden` above it: above, closing narrows the column (the map's
  existing `sidebar-closed` behaviour, which keeps the page renderer's measured
  width), and below, `display:none` takes the buttons out of the tab order,
  which `visibility` alone would not. A `.sidebar-backdrop` button dismisses by
  tap and is `tabindex="-1"` with the toolbar toggle as the keyboard route; it
  is `display:none` above the breakpoint so it can never eat a click on a
  desktop. Covered by a test in `tests/responsive-layout.test.js` and a wiring
  test in `tests/static-shell.test.js`; 367/367 frontend tests,
  `npm run check`, `npm run build`, and `make smoke-test` (5/5, both render
  modes) are green.

## Hardening — a full audit of the C host and the frontend

A two-part audit of `src/*.c` + `include/*.h` and of `frontend-vue/src` produced
these items. They are ordered by risk, not by ease. Everything below was
verified against the source rather than inferred; the entries that are *not*
problems are recorded too, at the end, because "leave this alone" is a finding.

Two structural things the audit confirmed and this section should not spend
effices on: `src/metrics.c` is correctly isolated (only `metrics.h`, `math.h`,
`stdint.h`, `stdlib.h`; the MANIFEST `core` profile links libc and libm and
nothing else), and the map's module split is a clean one-directional DAG
(`geo` → `map-projection` → `map-input` → `map-canvas` → `map-explorer`) that
exists to break a cycle. **App.vue's 1428-line template should not be split for
its own sake** — the panes need ~60 injected props each; the DOM harness from
TODO-017 covers a template of that size now.

### TODO-061 — Fix the use-after-free on the PDF extraction thread

- **Intent:** I3.1, I3.4, I4.1
- **Priority:** P0
- **Work:** The one real memory-safety defect in the codebase.
  `deliver_pdf_toc` is posted with `webview_dispatch`, which on the GTK backend
  is `g_idle_add_full` on the **default** `GMainContext`
  (`webview.h:1963-1971`) and **always** returns `WEBVIEW_ERROR_OK` — so the
  `WEBVIEW_FAILED(webview_dispatch(...))` cleanup at `src/pdf_session.c:291` is
  unreachable and "the view is gone" cannot be detected. On shutdown,
  `webview_app.c:300-304` joins the thread and then calls `webview_destroy`,
  whose destructor runs `g_object_unref(m_webview)` (`webview.h:1920-1921`) and
  *then* `deplete_run_loop_event_queue()` (`webview.h:1923-1925`) — which
  iterates that same default context and fires the pending source. The callback
  then calls `webview_return(w, …)` on the object being destructed.
  Close the window while `pdftotext` is running and this fires. When the source
  never runs, the milder consequence is a leaked response and a promise the
  frontend never sees settled.
  Fix the shutdown ordering: drain the dispatch queue after the join and before
  `webview_destroy`, or make the worker block until the UI thread acknowledges
  delivery. This is a shutdown-ordering contract, not a one-liner, and it needs
  a test that can actually reproduce the interleaving.
- **Done when:** closing the window during extraction neither leaks nor calls
  into a destroyed WebView, and the contract is written down where both sides
  can be held to it.
- **Note:** the comment at `pdf_session.c:38` ("guarded atomically across
  threads") and the unreachable error branch should be corrected in the same
  change, or they will mislead the next reader about what is safe.

### TODO-062 — Enforce the workspace size cap before reading the file — DONE

- **Intent:** I3.4, I4.1
- **Priority:** P1
- **Work:** `src/workspace_store.c` called `g_file_get_contents` and only then
  checked the length, so a multi-gigabyte `workspace.json` was fully allocated
  and only afterwards rejected as `TOO_LARGE` — on the GTK main thread, inside
  `on_load_workspace`. Add the `g_stat` pre-check, mirroring
  `text_transfer.c:152-187`.
- **Done when:** an oversized workspace is rejected from its metadata, and the
  post-read re-check remains for a file that grew in between.
- **Evidence:** `workspace_store.c` now stats first and compares against
  `WORKSPACE_STORE_MAX_BYTES`, with the post-read re-check kept for the TOCTOU
  window and its comment stating which is which. The module needed
  `<glib/gstdio.h>` for `g_stat`/`GStatBuf`, which it did not previously include.
- **The test is a source assertion, and that is a deliberate weaker claim.** The
  existing behavioural test proves only the *outcome*, which a post-read check
  also produces, so it cannot tell the two implementations apart. Two runtime
  probes for the ordering were tried and both failed to discriminate, which is
  recorded in the test's comment:
  - `chmod 000` so only a stat could succeed — this tree is a **fuseblk** mount
    that does not honour chmod for the owner (measured: mode stays 777), so the
    probe passes either way.
  - a sparse file via `ftruncate` past the cap — the read still succeeds,
    returning zeros, so the post-read check rejects it too.
  So `assert_the_cap_is_checked_before_the_read()` asserts the ordering on the
  source. It is weaker than a runtime measurement and fails on the real defect
  rather than on an environmental quirk: mutation-checked both ways — deleting
  the pre-check fails on `stat_call != NULL`, and moving it below the read fails
  on `stat_call < read_call`.

### TODO-063 — Reject `\u0000` and lone surrogates in the JSON reader — DONE

- **Intent:** I3.3, I3.4, I4.1
- **Priority:** P1
- **Work:** `json_read_string` (`src/json_io.c:148-162`) measures the true
  decoded length but writes a buffer whose `strlen` is shorter. Two consumers
  then measure with `strlen`: `text_transfer.c:249` **silently truncates a
  saved file at an embedded NUL**, and `workspace_bindings.c:98` rejects a save
  with a confusing `INVALID_PAYLOAD`. A lone surrogate also produces
  ill-formed UTF-8 (`ed a0 80`, CESU-8) that `json_append_string` re-emits into
  the reply the frontend parses and hands to `cairo_show_text`
  (`outline_pdf.c:247`).
  Reject `\u0000` and unpaired surrogates in `read_string` with
  `JSON_ERR_ESCAPE`, and add the three test cases `test_json_io.c` is missing —
  it currently covers only well-formed surrogate *pairs*.
- **Done when:** every decoded string's measured length equals its `strlen`, and
  ill-formed input is refused rather than silently reshaped.
- **Evidence:** `src/json_io.c` rejects `\u0000`, lone high/low surrogates, and
  high-surrogate-not-followed-by-low with `JSON_ERR_ESCAPE`; `tests/test_json_io.c`
  covers NUL, lone high, lone low, high+non-surrogate, high+text, plus the same
  three through `json_parse`. `make json-io-test`, `make test`,
  `make sanitized-test` green.

### TODO-064 — Stop splicing raw file bytes into a JSON response — DONE

- **Intent:** I3.3, I3.4
- **Priority:** P1
- **Work:** `on_load_workspace` (`src/workspace_bindings.c:59-76`) validates
  only that the first non-space byte is `{` and the last is `}`
  (`workspace_store.c:172-181`), then appends the file's bytes straight into
  the reply at line 71. A damaged file like `{"a": "unterminated` passes and
  produces a response that claims to be JSON and is not — bypassing the module
  (`json_io.h:5-16`) that is supposed to be the single owner of that decision.
  Parse for validation (and re-serialize, or return a typed
  `INVALID_CONTENT`). Related: `workspace_store_is_object` is a hand-rolled
  JSON validator living in the storage layer; `workspace_store.h:62`'s
  `workspace_store_decode_argument` is JSON decoding that belongs in
  `json_io.c`.
- **Done when:** `loadWorkspace` cannot return a body it would not accept.
- **Evidence:** `on_load_workspace` now rejects embedded NUL and validates with
  `json_parse` (must be `JSON_VALUE_OBJECT`) before splicing, else
  `INVALID_CONTENT`; `workspace_store_load` NOENT returns `g_malloc0` and the
  binding frees with `g_free` (was `calloc`/`free` mismatch). `make test`,
  sanitizer suites green.

### TODO-065 — Fix the silent-failure and leak paths in the PDF heading extractor

- **Intent:** I3.4, I4.1
- **Priority:** P1
- **Work:** Four defects in `src/pdf_toc.c`, all found by inspection and each
  small:
  - `:197-203` — a `realloc` failure abandons `lines` and every accumulated
    `key`/title, and returns `0`, which `extract_pdf_toc:268` ignores, so the
    OOM is invisible and the code falls through to a second pass.
  - `:171-173` — `g_spawn_sync`'s return value and the captured `wait_status`
    are both discarded, so a corrupt or encrypted PDF (non-zero exit) is
    reported to the user as "No headings could be extracted" and the real
    diagnostic is thrown away. The signature also accepts `error == NULL`,
    where it would report unconditional success and then dereference a NULL
    output.
  - `:262, 274, 280` — `extract_pdf_toc` never clears `*error`, and
    `g_set_error` is a no-op on a non-NULL `*error`. The header
    (`include/pdf_toc.h:62-67`) promises "0 with error set", and
    `pdf_session.c:282` reads `task->error != NULL`, so a stale error masks the
    real failure.
  - `src/pdf_session.c:279-281, 154-156, 328-330, 123-127` — unchecked
    `g_new0`/`g_strdup` results on the PDF path, including a `calloc` failure
    reported as `PDF_TOO_LARGE`.
- **Done when:** a `pdftotext` non-zero exit, a `realloc` failure, and a
  pre-set `*error` each produce a distinct, tested outcome — and none of them
  leaks.

### TODO-066 — Wire the dismiss button to the report it claims to dismiss — DONE

- **Intent:** I2.2, I2.5
- **Priority:** P1
- **Work:** `App.vue:637` is `@click="workspaceReport = null"`, which clears the
  *local* ref and never calls `clearWorkspaceReport()` — which exists at
  `workspace.js:287`, is tested, and is **not imported by the app**. The
  module-level report therefore survives, and the very next debounced
  `persist()` calls `refreshReport()`
  (`workspace-persistence.js:65-67`) and resurrects the pill. The deep watcher
  at `App.vue:387` fires 250 ms after any state change, so: the user dismisses
  the "workspace not saved" warning, types a word, and the warning returns.
  This is the only control the user has over the one warning that says their
  work is not being saved.
  Import `clearWorkspaceReport`, add it to the `store` bundle, and call it.
  Then cover it — the button exists and has an id, so the DOM harness can
  click it.
- **Done when:** dismissing the report keeps it dismissed across a subsequent
  save, and a test proves it by clicking the button and then triggering a save.
- **Evidence:** `workspace-persistence.js` gained `dismissReport()` (clears the
  module report via `store.clearWorkspaceReport`, then `refreshReport`);
  `App.vue` imports it, passes it in the store bundle, and binds
  `@click="dismissWorkspaceReport"`. `tests/workspace-persistence.test.js`
  proves dismiss-then-persist stays dismissed; `tests/static-shell.test.js`
  locks the wiring and rejects the old `@click="workspaceReport = null"`.
  534/534 frontend tests green.

### TODO-067 — Surface the host's error code, or stop claiming to — DONE

- **Intent:** I2.2
- **Priority:** P1
- **Work:** `runNativeCall` (`native-bridge.js:31-49`) goes out of its way to
  preserve `code` through normalization, and its comment claims "so the code
  survives into the caller's status line." It does not: `withFileTransfer`
  does `say(result.error.message || failed, true)` (`file-io.js:188`) — message
  only — so the host's protocol codes (`NOT_A_PDF`, `PATH_GONE`, `QUOTA`, …) are
  structurally unreachable in all six file-transfer status lines and the app
  falls back to a generic "Could not open the PDF." `workspace.js:302-318` *does*
  read `code`, so the codebase has two policies for one host error and a comment
  that is wrong about the first.
  Either include the code in the one `say()` call (fixes all six callers) or
  correct the comment. The first is better; the codes are already in the
  protocol and are otherwise dead weight.
- **Done when:** a host rejection with a `code` produces a status line that
  distinguishes it from a message-only failure.
- **Evidence:** `file-io.js` reports `${message} (${code})` when a code is
  present, message alone otherwise — one line fixing all six callers.
  `tests/file-io.test.js` pins both halves; `tests/outline-pdf.test.js`
  now expects `pick one (NO_WORKSPACE_DIRECTORY)`. 534/534 frontend green.

### TODO-068 — Cover the panes the DOM harness cannot currently reach

- **Intent:** I4.1
- **Priority:** P1
- **Work:** `tests/support/dom-globals.mjs` declares 8 bindings; the app calls
  13. Missing: `openPdfAt`, `openImageDirectoryAt`, `chooseOutlineDirectory`,
  `renderOutlinePdf`, `smokeVerdict`. Every path through those silently takes
  the no-host fallback, so the 14 mounted tests cover the outline and the
  editor and nothing else — not the reader pane, the thumbnail grid, the map
  pane, the lightbox, the remembered-path reopen ("heal the list"), or the
  combined-PDF flow. Adding the five names is one line and unblocks the largest
  coverage gap in the suite.
- **Done when:** each of the five panes has at least one mounted test that
  exercises a binding it actually calls.

### TODO-069 — Route the reader's render failures to a status line

- **Intent:** I2.2
- **Priority:** P2
- **Work:** `App.vue:1141` and `:1143` (zoom) and `:1137`/`:1139` (page change)
  call `renderAllPdfPages`, which rethrows non-cancellation errors
  (`pdf-session.js:181`), with nothing catching them — a failed render is
  console-only, and `pdfRenderError` and the status line never see it. The
  *same* call in the view watcher at `App.vue:438-446` is wrapped and routes to
  `setPdfStatus(..., true)`, so the identical failure is silent on zoom and
  visible on tab-switch. `loadPdfToc()` at `pdf-session.js:289` is also
  fire-and-forget, which can leave the TOC panel reading "Extracting headings…"
  forever. Add a `setZoom`/`goToPage` helper in `pdf-session.js` that owns the
  try/catch, and catch the TOC call.
- **Done when:** every path that can fail a render reaches the same status
  line, and none of them leaves a panel in a permanent loading state.

### TODO-070 — Fix the pluralization drift with one helper

- **Intent:** I2.1, I4.4
- **Priority:** P2
- **Work:** ~20 hand-rolled pluralization sites across `App.vue` (5),
  `map-places.js` (4), `toc-outline.js` (5), `image-session.js` (3),
  `pdf-session.js` (3), `outline-pdf.js` (2). It has **already** drifted:
  `image-session.js:194` hardcodes `images` and overwrites the correctly
  pluralized message `setImageCollection` set at `:100`, so one image plus one
  oversized file reads "1 images loaded; 1 skipped by browser limits." The only
  test for that line uses 2 images, so CI cannot see it. One `plural(n, one,
  many?)` in `workspace.js` (already the string/label home) applied
  everywhere.
- **Done when:** the "1 images" case is covered by a test, and no template or
  session builds a count suffix by hand.

### TODO-071 — Move work out of the template and off the map's hot path

- **Intent:** I4.4
- **Priority:** P2
- **Work:** Two clear cases of per-render work that belongs in a computed.
  - `countWords(item.content)` is called twice per row, in two lists
    (`App.vue:780`, `:859`); each call is a `trim()` + `split(/\s+/)` over the
    whole section body. With the `{ deep: true }` watcher at `App.vue:387`
    firing on every keystroke, a 50-section outline with real drafts does 100
    full-body splits per keystroke.
  - `placeMarkerOffset(place)` is called twice per place
    (`App.vue:1301`, and again inside `markerStyle` at `:1304`/`:554`), each
    doing two projections. `MAX_SAVED_PLACES` is 200 and the render pass fires
    on **every `pointermove`** (`map-explorer.js:645-648`), so this is 400
    projections per mouse move. Compute the offsets once in a `computed` map
    keyed by id and look them up.
- **Done when:** neither function is called from the template, and the word
  count is memoized per item.

### TODO-072 — Make the host read its bindings without a browser global — DONE

- **Intent:** I1.2, I4.1
- **Priority:** P2
- **Work:** `getNativeBinding` (`native-bridge.js:16`) reads a bare `window`
  identifier, which is a `ReferenceError` outside a browser rather than
  `undefined` — so any non-DOM consumer of `createPdfSession` /
  `createImageSession` gets a hard throw instead of the documented "no host,
  fall back to the file input" path. The comment at `workspace.js:394-398`
  exists to explain exactly this function and contradicts it. Use
  `globalThis.window?.[name]`. (The DOM harness had to work around this to
  write its first test.)
- **Done when:** a plain-node consumer of any session reports "no host" rather
  than throwing.
- **Evidence:** `native-bridge.js` reads `globalThis.window ?? globalThis`,
  so no `window` global means null instead of a `ReferenceError`.
  `tests/native-bridge.test.js` now asserts null with `window === undefined`.
  534/534 frontend green.

### TODO-073 — Give the extraction thread and the bindings test coverage

- **Intent:** I4.1
- **Priority:** P1
- **Work:** 5 of 14 `src/*.c` files have no suite: `pdf_session.c` (**all three
  bindings, and the program's only thread**), `image_directory.c` (the depth /
  count / byte budgets and the `NOFOLLOW_SYMLINKS` claim),
  `workspace_bindings.c` (including the three documented error paths),
  `webview_app.c`, and `lua_metrics.c` (which is also missing from
  `tests/MANIFEST`, so `ctest` never runs it). Untested branches inside *tested*
  files include `json_io.c:196-200`'s heap path for more than four strings (no
  caller ever passes more than two, so it never executes) and
  `app_support.c:137-161`'s `dispatch_picker_with_payload`, whose
  payload-ownership rule is the one whose violation leaks.
  This is the largest single coverage hole in the project and it is why TODO-061
  has no natural test today.
- **Done when:** each of the five has a suite, and the two unreachable-in-
  practice branches above are executed by one.

### TODO-074 — Report truncation instead of dropping data silently

- **Intent:** I2.5, I3.4
- **Priority:** P2
- **Work:** Three places drop data with no signal, each contradicting a policy
  the same file states. `outline_pdf.c:47, 308` caps at `MAX_ITEMS` with no
  flag in the reply, while `outline_pdf.c:155-157` says "silently dropping the
  overflow would lose part of a draft, which for a document builder is the one
  unacceptable failure." `image_directory.c:70` skips directories at the depth
  limit without setting `limited`, so the reply claims a complete scan of a
  truncated tree. `image_directory.c:91` drops any file that changed size
  between query and read. Add a truncation flag to each reply.
- **Done when:** a reply can never imply completeness it does not have, and each
  flag is tested.

### TODO-075 — Pick one allocator domain per module

- **Intent:** I4.4
- **Priority:** P3
- **Work:** The two halves of the codebase disagree about which allocator is
  correct, so the rule documented in `app_support.h:13-15` ("free with `g_free`
  or `free`, exactly as documented on each declaration") is unenforceable.
  `json_io.c` frees `malloc`/`calloc` memory with `g_free` (`:307, 313-316`)
  and `workspace_bindings.c:61, 78` frees `g_malloc` with `g_free`; `pdf_toc.c`
  frees `g_malloc` with `free` (`:27, 315`). With GLib's default vtable these
  all happen to be libc `malloc`, so nothing misbehaves today and ASan will not
  flag it — it breaks the moment `g_mem_set_vtable` is used or the code is
  ported. Make each module consistent (`json_io.c` plain `malloc`/`free`;
  `pdf_toc.c` `g_free` throughout).
- **Done when:** no module frees memory with the other domain's deallocator, and
  the header rule is enforceable.

### TODO-076 — Consolidate the five error conventions

- **Intent:** I3.3, I4.4
- **Priority:** P2
- **Work:** Six error conventions across the pure layers — `json_result`,
  `metrics_error`, `bridge_error`, `text_transfer_status`,
  `workspace_store_result`, and `GError*` in `pdf_toc.h` — with six separate
  `*_strerror` tables. `json_io.h:5-16` positions itself as *the* codec, so the
  request-decoding side deserves the same consolidation it gave the response
  side. Separately: `include/app_support.h:20-21` pulls in `<webview/webview.h>`
  and `<glib.h>`, which is why `tests/stubs/` exists at all —
  `json_io.h:18` gets this right (glib only, no webview) and `app_support.h`
  is the header that forces the coupling. And `app_context` is a fully public
  struct dragging `webview_t`, `GThread *` and `int exit_code_override` into
  every layer-3 module, five of which can corrupt the PDF thread handle.
  Make it opaque with accessors.
- **Done when:** the request and response halves of the host have one error
  vocabulary, and a layer-3 module can be compiled without the webview header.

### TODO-077 — Fix the stale and wrong comments that mislead the next reader

- **Intent:** I4.4
- **Priority:** P3
- **Work:** A handful of comments state the opposite of what the code does, and
  in a starter template those are the most expensive kind of defect.
  `include/smoke.h:41-44` says decoding is "deliberately strict: no escape
  sequences" while `smoke.c:65` uses `json_read_string_array`, which fully
  resolves them. `src/pdf_session.c:38` claims a cross-thread guard the GTK
  backend does not provide. `image_directory.h:8-10` says the byte budget keeps
  a huge tree "from stalling the GTK main loop" while the scan runs *on* that
  loop. `workspace_store.c:95-98` says the module has "no allocator" in a file
  that calls `g_file_get_contents`. `webview_bridge.c` reimplements a laxer JSON
  parser than `json_io.c` already provides and accepts `0x10` as 16
  (`json_io.c:344-369` has the same hole, accepting `1e999` as `+inf`, which
  `outline_pdf.c:479` then formats with `%.2f`).
- **Done when:** no comment in `src/` or `include/` describes behaviour the code
  does not have, and the number grammar is strict.

### Audited and deliberately left alone

Recorded so the next audit does not re-raise them:

- `src/metrics.c` is correctly isolated — no glib, no GTK, no webview, and the
  MANIFEST `core` profile links only libc and libm. The Welford `m2` clamp was
  stress-tested at 200 000 randomised trials and constant values from 1e7 to
  1e16 with no negative variance; the guard is adequate.
- `json_io.c`'s two-pass measure-then-allocate design is sound. I tried to make
  the measuring and writing passes disagree via `\u0000`, lone surrogates, and
  surrogate pairs and could not. TODO-063 is about what the codec *accepts*, not
  about the allocation strategy.
- `app_support.c:31-51`'s `build_file_url` bounds are exactly right, including
  the `%XX` case, and the worst case is covered by the caller's
  `calloc(PATH_MAX*3+8)`. No off-by-one.
- `text_transfer.c:152-187`'s stat-then-read-then-recheck is the right pattern
  including the TOCTOU re-check; it is the counterexample that makes TODO-062 an
  oversight rather than a design choice.
- `workspace_store.c:125-170`'s temp-file + `fsync` + `rename` + directory-
  `fsync` sequence is correct, and `sync_directory`'s `PATH_MAX` handling is
  right. One nit not worth its own TODO: a directory-`fsync` failure at `:163`
  reports `WRITE_FAILED` *after* the rename succeeded, so a legitimate save is
  reported as a failure.
- `image_directory.c:59-70`'s scan is depth-bounded at 8 and uses
  `G_FILE_QUERY_INFO_NOFOLLOW_SYMLINKS`, so neither a symlink loop nor a deep
  tree can hang it.
- The PDF worker/UI split is correctly done in the ways that usually go wrong:
  no webview call from the thread, all request state `g_strdup`'d into the task,
  and every worker exit path frees it.
- `withFileTransfer` (`file-io.js:166-199`) is the best-designed thing in the
  codebase — one implementation replacing six copy-pasted ladders, three
  outcomes handled once, and a return shape that lets callers branch without
  parsing messages. TODO-067 changes one line of it and must keep it that way.
- The map's `let`-vs-`ref` choices (`dragStart`, `observer`, `flight`,
  `commitTimer`) are correct: none is read by the template, and making them refs
  would cost reactivity tracking for nothing.
- The duplicate `window.addEventListener('resize', …)` at `App.vue:600` and
  `map-explorer.js:873` is the same function reference, so the DOM dedupes it
  and neither needs removing. Not a leak.
- `App.vue`'s `v-show`-everywhere decision is load-bearing for the WebKit
  repaint watcher, the canvas measurement, and `smoke.js`'s anchor check, and
  is commented as such in all three places.
- All 9 C suites pass and every translation unit compiles warning-free under
  `-Wall -Wextra -Wpedantic -Wshadow`. `tests/MANIFEST` is genuinely read by
  Make, build.lua, and CMake, and the three cannot drift.

## Library-readiness — becoming extractable without extracting yet

**This section is a plan, not work.** Nothing here is started. The goal is that
either half could move to its own repository with a one-line path change, while
the application keeps building and shipping from one tree the whole time. No
package split, no new build system, no `packages/` directory: the deliverable is
that the boundaries already exist and are enforced.

The rule that makes this achievable without a big-bang move: **every module
keeps working where it is, and gains a test that proves it does not depend on
anything outside its intended set.** A module that passes is extractable; one
that fails has told us the truth about its coupling before it cost anything.

### What the trees already give us

Both halves are further along than a typical single-tree project, and it is worth
recording why, because the plan is mostly about *not losing* this.

**Backend.** `tests/MANIFEST` already declares a dependency *profile* per suite —
`core` links libc and libm only, `glib` adds glib, `pdftotext` adds the
extractor, `gtk-stub` and `cairo` add the host. That is a dependency graph
expressed as data, and it is the same thing a library's build manifest would say.
`src/metrics.c` is already a library: `metrics.h` includes only `<stddef.h>`, the
implementation adds `math.h`/`stdint.h`/`stdlib.h`, and the `core` profile proves
it by compiling it with nothing else linked. `webview_bridge.c` and `json_io.c`
are one step out — they need glib for strings, nothing more. `pdf_toc.c` needs
`pdftotext` on `PATH` and nothing from the host.

**Frontend.** The dependency graph is already a clean DAG in the pure half:
`geo.js` imports nothing; `map-input.js`, `image-viewer.js`, `map-canvas.js`,
`workspace-report.js` import nothing; `map-projection.js` imports only `geo.js`.
Six frontend files have no Vue import and no internal dependency at all. That is
a library boundary that already exists and is not being tested as one.

### TODO-078 — Declare the library boundary in one manifest

- **Intent:** I4.4, I4.3
- **Priority:** P2
- **Work:** Write `LIBRARIES.md` naming each candidate, its intended form
  (language, module system, licence, dependency floor), and — the part that
  matters — its *public surface*, meaning the names a consumer may import and
  the ones it must not. The backend half is already 90% written in
  `tests/MANIFEST`'s profiles; the frontend half has no equivalent and needs
  one. Include the explicit decision not to split yet, and what would change
  that.
- **Done when:** a contributor can read one file and know which files are library
  candidates, which are app-only, and what each library promises.

### TODO-079 — Make the frontend's pure half provably dependency-free

- **Intent:** I4.4, I4.1
- **Priority:** P2
- **Work:** Add `frontend-vue/tests/module-boundaries.test.js` that parses the
  import graph and asserts each library-candidate module imports nothing outside
  its declared set. Today that is: `geo.js`, `map-input.js`, `map-canvas.js`,
  `image-viewer.js`, `workspace-report.js`, `map-projection.js` (→ `geo.js` only),
  `native-bridge.js`, `file-io.js`, `workspace.js`. Two of them reach for browser
  globals — `map-canvas.js` (`requestAnimationFrame`, `Image`) and
  `file-io.js`/`image-viewer.js` (`FileReader`, `Blob`, `document`) — so the test
  must also assert the *shape* of that reach: a global read through an injected
  or lazily-resolved reference, not a module-level capture that would freeze
  "no document" for a Node consumer. This is the same failure
  `session-factories.test.js` already documents for `doc`.
- **Done when:** the test fails if a candidate gains a Vue import, a sibling
  import outside its set, or a top-level browser-global capture.
- **Note:** this is the item that makes the frontend half as honest as the
  backend half already is. `tests/MANIFEST` proves the C layering; nothing
  proves the JS layering.

### TODO-080 — Break the frontend's boot-state cycle at the source

- **Intent:** I4.4, I1.5
- **Priority:** P2
- **Work:** `boot-state.js` is nine lines and every session imports it: it calls
  `loadWorkspace()` at module scope and exports the result, so importing any
  session reads `localStorage` as a side effect. That is the one thing that
  stops `workspace.js`, `image-viewer.js`, and the map modules from being
  libraries — a library must not read the environment when it is imported, or it
  cannot be imported by a test, a CLI, or a server renderer. Turn it into
  `bootSnapshot()`, called by `App.vue` and passed into each factory (the
  factories already accept `boot` as an injected default). `workspace.js` is the
  same shape: `idSequence`, `workspaceReport`, `nativeSaveChain`, and
  `lastNativePayload` are module-level mutable state with no factory and no
  reset, so `saveWorkspaceNative`'s identical-payload dedupe is process-global.
  Fold it into a `createWorkspaceStore()`.
- **Done when:** importing `workspace.js` touches no global, and the existing
  211 session-factory tests plus the DOM harness still pass without a `?fresh=`
  reload for the state reason (the harness may keep it for other reasons).
- **Caution:** the DOM harness's `?fresh=N` trick currently works around
  *both* leaks. Fix this properly and that workaround should get simpler, not
  more elaborate; if it does not, that is a signal something else is leaking.

### TODO-081 — Make the backend's layer-3 modules compile without the webview header

- **Intent:** I4.4, I3.3
- **Priority:** P2
- **Work:** The blocking issue for extracting anything host-side, and the reason
  `tests/stubs/` exists at all. Six headers — `outline_pdf.h`,
  `text_transfer.h`, `smoke.h`, `image_directory.h`, `pdf_session.h`,
  `workspace_bindings.h` — all `#include "app_support.h"`, which includes
  `<webview/webview.h>` and `<glib.h>` (`app_support.h:18-21`). So a pure
  function like `image_mime_type()` or `pdf_toc_count_characters()` cannot be
  compiled by a consumer without vendoring a webview header. Each of the six
  uses exactly one thing from it: the `webview_t` in its callback signature, plus
  `app_context` for the few that store state. Make the type an opaque
  forward declaration (`typedef struct webview_impl *webview_t_handle`, or
  `void *`) in a tiny `webview_handle.h` that includes nothing, and make
  `app_context` opaque with accessors — it currently drags `webview_t`,
  `GThread *`, and `int exit_code_override` into every layer-3 module, five of
  which can corrupt the PDF thread handle. `json_io.h:18` already gets this right
  (glib only, no webview) and is the model.
- **Done when:** `image_directory.h` and `pdf_toc.h` compile with only glib
  linked, and `tests/stubs/` can be deleted rather than maintained.
- **Blocks:** any real extraction of the host-side libraries. This is the
  prerequisite, and it is genuinely a prerequisite rather than a nice-to-have.

### TODO-082 — Make each backend profile a standalone target

- **Intent:** I4.4, I4.3
- **Priority:** P3
- **Work:** The `MANIFEST` profiles already describe four dependency floors.
  Give each one a real build target (a static or shared library) so a consumer
  links `libmetrics.a` rather than recompiling `src/metrics.c`, and so the
  library's own ABI is a thing the build can check. This is the last step before
  extraction and is explicitly *not* recommended yet — see the sequencing note
  below.
- **Done when:** `make lib` produces one artifact per profile and the app links
  them.

### Sequencing, and the recommendation not to extract yet

**Do not create a second project now.** The cost is concrete and the benefit is
not yet: the frontend's only real library candidate is the map's pure geometry
(three files, ~40 KB, no consumers outside this app), and the backend's best
candidate is `metrics.c`, which is 200 lines and already a clean library. Neither
pays for a repository, a package registry entry, a version, and a second CI
matrix.

The value is entirely in the *seams*, and the seams are cheap to build in place:

1. **TODO-079 and TODO-081 are the real work.** They make the boundaries
   enforceable by a test, which is what turns "extractable" from a claim into a
   fact. Both are refactors of dependency direction, not moves.
2. **TODO-080 follows**, because a library that reads `localStorage` on import
   is not a library regardless of where its files live.
3. **TODO-078 is the first step**, since it decides what "candidate" means.
4. **TODO-082 last, and only when there is a second consumer.** A library with
   one in-tree consumer is a package with extra ceremony.

If a second consumer appears — a CLI, a server, another app — the intended path
is `git subtree` split or a workspace, not a rewrite: every module already keeps
its current import path, so the move is a path prefix and a manifest entry.

### Explicitly not planned

- **Not** a monorepo workspace manager (npm/pnpm/cargo). One `package.json` is
  fine at this size, and adding one now would be a toolchain dependency paid for
  a boundary that does not exist yet.
- **Not** a stable C ABI for `metrics.h`. It is a C library in a C program;
  versioned symbols are a distribution concern, and there is no distribution.
- **Not** a public API for the bridge protocol beyond what
  `docs/bridge-protocol.md` already documents. The protocol is the contract; the
  C structs are an implementation detail of one host.
- **Not** moving `src/`, `include/`, or `lua/` to a `packages/` layout. A rename
  with no consumer is churn, and it would touch every build file, the MANIFEST,
  and 12 test suites for no gain.

## Combined-outline PDF — the preview is lossy and the export is untested

**I2.1**, **I2.5**, **I4.1**

The TOC Manager already collects every draft, and `src/outline_pdf.c` already
turns the whole outline into one paginated PDF that the existing reader opens as
a preview (`Combine to PDF` → `Preview`, `App.vue:570-595`). So "render every
text content by TOC structure" ships. What does *not* work is the round trip: the
renderer is told the exact level of every item and encodes it in a way the reader
cannot read back, so the preview's contents panel silently loses part of the
document. These four items fix that, and the last one is the one that would have
caught it.

A finding that changed the design, recorded because the wrong answer was
considered first: **real PDF `/Outlines` bookmarks are not the fix.** The
reader's contents panel is `extractPdfToc`, which re-derives headings from
`pdftotext -tsv` text runs and font sizes (`pdf_toc.c:264`) and never reads the
outline tree. Bookmarks in the file would be invisible to this app's own preview.
Cairo 1.18 also emits PDF 1.7 with compressed object streams and an xref *stream*,
so patching the catalog in place is not viable either — verified by generating a
file and finding zero `/Outlines` objects and the catalog inside a deflated
object stream. The lever is font size.

### TODO-083 — Raise H3 above the reader's detection floor — DONE

- **Intent:** I2.1, I2.5
- **Priority:** P1
- **Work:** `src/outline_pdf.c:49` sets `heading_sizes = {18.0, 15.0, 12.5}`
  against `BODY_SIZE 10.5`. The reader requires
  `PDF_HEADING_MEDIUM_RATIO` (1.25, `pdf_toc.c:41`) *and* `is_title_like()`.
  H1 and H2 cleared it; H3 did not, so every H3 subsection vanished from the
  preview's contents panel. Raise H3 to 13.5pt.
- **Done when:** a rendered PDF's H1, H2, and H3 all appear in the reader's
  contents panel, at the right depth.
- **Evidence (chose 13.5pt):** the ratio is *measured*, not nominal — `pdftotext`
  reports the ink bounding box of a run, so a 10.5pt body measures about 14.30
  and the size-to-nominal relationship is not 1:1. Measured on a real render of
  the three levels: H1 18.0pt → 1.71x, H2 15.0pt → 1.43x, H3 12.5pt → **1.19x**
  (rejected), H3 13.5pt → 1.29x, H3 14.0pt → 1.33x. 13.5 is the smallest that
  clears 1.25 with margin, so it is what shipped; 14pt remains defensible and the
  comment records why 13.5 was chosen.
- **Verified by running the real pipeline**, not by arithmetic: a probe linked
  `pdf_toc.c` and fed it a cairo-rendered document, confirming `count=2` before
  the change and `count=3` after. That also exposed a second, independent gate —
  see TODO-084's note on sentence case.

### TODO-084 — Pin the heading sizes to the reader's own thresholds — DONE

- **Intent:** I4.1
- **Priority:** P1
- **Work:** Add a test that fails if a heading size drops below what the reader
  can detect, reading the reader's constant rather than hardcoding `1.25`, and
  covering all three levels.
- **Done when:** lowering any of the three heading sizes below the reader's floor
  fails `make test` with a message naming the ratio.
- **Evidence:** new suite `tests/test_outline_roundtrip.c` (4 tests) on a new
  `cairo-pdftotext` MANIFEST profile — cairo + pdftotext, no GTK, so it renders
  through the real `on_render_outline_pdf` and reads back with the real
  `extract_pdf_toc`. This was the only way to answer the question: the two halves
  were previously tested against fixtures, and neither asked whether the headings
  *this* renderer draws are headings the extractor recognises. `make test`,
  `make sanitized-test` (ASan/UBSan), `lua build.lua test`, and `ctest` (10/10)
  all run it; the profile needed wiring in all three build systems and in
  `CMakeLists.txt`.
  `PDF_HEADING_MIN_DETECT_RATIO` is now published in `pdf_toc.h` so the renderer
  and the test read one number; `pdf_toc.c` documents that the private
  `PDF_HEADING_MEDIUM_RATIO` is its twin.
  Mutation-checked: reverting H3 to 12.5pt fails the suite with
  `expected heading [A Subsection], extracted 3` — the original bug, named.
- **A second, independent limit found and recorded, not fixed:** `is_title_like`
  (`pdf_toc.c:114`) accepts a heading only if it is all-caps or has no lower-case
  word start, so a sentence-case H3 like "A subsection here" is rejected on the
  text alone however large it is drawn. That is not the renderer's to satisfy —
  the fix would be mangling the author's capitalisation — and it is the stronger
  argument for TODO-085 (return the structure in the reply) rather than for
  further size tuning. A test asserts the limit so it stays visible and fails
  loudly if someone improves the heuristic.
- **One implementation change fell out:** `src/outline_pdf.c` included
  `<gtk/gtk.h>` while using nothing from it. That stale include is what forced
  the renderer to need a toolkit; removing it is why the new profile needs no GTK.
  The file's comment now says so.

### TODO-085 — Return the outline structure in the render reply

- **Intent:** I2.1, I1.5
- **Priority:** P2
- **Work:** `on_render_outline_pdf` answers `{path, name, pages, bytes}`
  (`outline_pdf.c:474-486`). Add `outline: [{id, title, level, page}]`, built from
  the same `clamp_level()` and page counter the renderer already has — exact
  rather than re-derived. Then the frontend can show a truthful contents panel
  for a generated file without parsing the PDF, and can offer "jump to section"
  from the outline list directly. The binding is testable in the existing
  `test_outline_pdf.c`; the panel is a small addition to
  `frontend-vue/src/outline-pdf.js`, which already stores `lastOutlinePdf`.
- **Done when:** the reply carries the structure, and the TOC Manager can navigate
  by it without opening the PDF.
- **Fold TODO-074's flag in here** rather than separately: both change the same
  reply.

### TODO-086 — Report truncation instead of dropping outline items — DONE

- **Intent:** I2.5, I3.4
- **Priority:** P1
- **Work:** `outline_pdf.c:47` defines `MAX_ITEMS 10000` and `:308` applies it
  with `if (total > MAX_ITEMS) total = MAX_ITEMS;` — dropping every item past
  the cap with nothing in the reply. The same file states at `:155-157` that
  "silently dropping the overflow would lose part of a draft, which for a
  document builder is the one unacceptable failure", so this contradicts the
  module's own policy. Add a truncation flag to the reply, alongside the
  equivalent flags TODO-074 wants in `image_directory.c`.
- **Done when:** a reply can never imply completeness it does not have, and the
  flag is tested.
- **Evidence:** reply carries `"truncated":true/false` (computed from
  `json_count(items) > MAX_ITEMS`); frontend stores it and reports “only the
  first 10000 items were rendered”; docs updated. Tests: small render
  `truncated:false`, 10001-item render `truncated:true` + valid PDF, in
  `tests/test_outline_pdf.c`; frontend truncated-status case. While testing,
  found and fixed a real `json_io.c` defect: `reserve_slot`/`reserve_member`
  doubled on every push (no `count>=capacity` guard), so 10k siblings hit the
  overflow guard and returned `JSON_ERR_MEMORY` — now guarded, 10k parses.

### TODO-087 — Fix the two UTF-8 and unsanitised-name defects in the export path — DONE

- **Intent:** I3.4, I4.4
- **Priority:** P2
- **Work:** Two small export-path defects, both about the file name rather than
  the content:
  - `sanitize_pdf_name` (`outline_pdf.c:360-362`) truncates with
    `g_string_truncate(name, 120)` on a raw byte offset, so a name of 119 ASCII
    characters plus one two-byte character leaves a dangling lead byte and then
    appends `.pdf` — an invalid UTF-8 filename. Its sibling already gets this
    right at `text_transfer.c:88-93`, backing off over continuation bytes. Reuse
    that.
  - `text_transfer_suggest_name` (`text_transfer.c:102-107`) returns the caller's
    `fallback` **verbatim** when the sanitized name is empty — no sanitizing, no
    60-char cap. Every current caller passes the literal `"export.txt"`, so it is
    latent, but the header (`text_transfer.h:39-45`) advertises a "safe base
    name", so a future caller passing a dynamic string would get a path. Run the
    fallback through the same scrubber.
- **Done when:** no name this path produces can contain a partial UTF-8
  sequence, and the fallback is sanitized like every other name.
- **Evidence:** `sanitize_pdf_name` backs off over `0x80` continuation bytes
  before truncating to 120; `text_transfer_suggest_name` runs the fallback
  through itself (max depth 2, terminates on `export.txt`). Tests:
  `test_suggest_name_sanitizes_fallback` (path traversal, reserved chars,
  dot-only→default), `test_long_utf8_name_stays_valid` (`g_utf8_validate` on
  the written file). Sanitizer suites green.

### Not planned for this feature

- **Real PDF `/Outlines` bookmarks.** Would help other PDF readers open the file
  with a populated bookmark panel, but not this app's preview (see the finding
  above), and against cairo's PDF 1.7 output it means hand-writing an incremental
  xref-stream update. Worth doing only if the file is expected to leave the app.
- **Embedding attached images.** `MAX_IMAGES_PER_ITEM` is 64 per outline item
  (`workspace.js:35`) and the outline links carry them, so a combined PDF
  currently omits every image an author attached. Real, and a much larger
  problem (decode, scale, paginate) than the text renderer;
  `outline_pdf.c:1-13` says so explicitly rather than half-doing it. It deserves
  its own entry when it is wanted — it is *not* folded in here, because a TODO
  that hides a decode-and-paginate project behind a "nice to have" is worse than
  an absent one.

### TODO-088 — Show thumbnails instead of full-resolution originals — DONE

- **Intent:** I2.5, I3.4, I4.1
- **Priority:** P1
- **Work:** `openImageDirectory` returned every accepted image as a base64 data
  URL of the *original* bytes, and the frontend held all of them for the session.
  The grid renders them at 140px tall, so a 12 MP photo was kept at full
  resolution to fill ~187×140 CSS pixels — about 4,700× more pixels than are
  displayed. Have the scan emit a downscaled thumbnail for the grid and the
  original's path for the lightbox.
- **Done when:** opening a directory of large photos holds thumbnails, not
  originals, and the lightbox still shows the full image.
- **Evidence:** `image_directory.c` now decodes each image with GdkPixbuf
  (already linked transitively by GTK), scales its longest edge to 320px
  preserving aspect, flattens onto white, and re-encodes as JPEG. Each reply
  entry carries `thumbnail`, `path`, `width`, `height`, `mime`, `size`.
  Measured end-to-end on 50 generated 4032×3024 photos (15 MB on disk): the
  reply is **296 KB**, against ~20 MB for the base64 of the originals — a **65×
  reduction**, and linear in collection size. The single-image test measured
  329,152 B on disk → 5,880 B of base64, 75× smaller.
  A new `loadImageAt` binding serves one full-resolution image for the
  lightbox, which holds one at a time and releases it on step and on close.
  The browser path (`webkitdirectory` preview) does the same through
  `createImageBitmap` plus a canvas, injected so `image-viewer.js` stays free of
  DOM globals and testable in plain node.
- **The security property, which is the reason the binding is not a file
  reader:** `loadImageAt` accepts a path only if the last scan walked it, and the
  list is cleared at the start of every scan. Without that check the binding
  would return any file the page named, base64-encoded — a capability the rest
  of the bridge deliberately lacks. It is also bounded by the same per-file cap
  as the scan, so a file that grew since the walk is refused rather than read.
- **Why `loading="lazy"` was not the fix:** it is already set (`App.vue`) and
  defers decode and paint, not a string already in the heap. The resident base64
  was the unbounded half.
- **Also removed:** the result was built into one `GString`, so a 96 MB scan
  peaked at ~293 MB — the doubling growth of the final 128 MB string, plus one
  16 MB file buffer and its 21 MB base64 copy, then 128 MB across the bridge and
  another 128 MB when WebKit parsed it. Three copies for one scan. A `dataUrl`
  alias of the thumbnail was also briefly emitted and then cut: it doubled the
  payload for a compatibility claim that was speculative and therefore unearned.
- **Tests:** new `tests/test_image_directory.c` (12 tests) on a new
  `gtk-pixbuf` MANIFEST profile — the decoder is linked for real, because "is the
  thumbnail actually smaller" is the claim and a fake decoder cannot test it.
  Images are generated with GdkPixbuf rather than checked in, so the suite is not
  tied to one decoder's output bytes, and the size assertion is a *ratio* so it
  holds across libjpeg builds. Mutation-checked: sending the original instead of
  a thumbnail fails, removing the path allowlist fails, dropping `limited` fails,
  and dropping the fallback count fails. `make test`, `make sanitized-test`,
  `lua build.lua test`, and `ctest` (11/11) are green.
- **Note on the module's test coverage:** this file had **no suite at all** before
  this — one of the five modules TODO-073 names as untested, and the reason both
  defects above went unnoticed.

### TODO-089 — Report the scan's honesty in the reply — DONE

- **Intent:** I3.4, I2.2
- **Priority:** P2
- **Work:** `image_directory.c` set `result->limited` when the depth, count, or
  byte budget stopped the walk, but the reply did not say so — a truncated scan
  read as a complete one. Emit the flag and show it. Folds in the
  `outline_pdf.c` half of TODO-074, since both are the same defect: a reply that
  implies completeness it does not have.
- **Done when:** a reply can never imply completeness it does not have.
- **Evidence:** the reply carries `limited` and `fallbacks`. `fallbacks` counts
  images whose original had to be sent because no thumbnail could be produced —
  a format with no GdkPixbuf loader, a truncated file, a decode that fails for
  memory — which is exactly the case that puts the memory back, so the number is
  what makes the change auditable rather than merely hopeful. Both are covered by
  `test_the_reply_always_states_its_honesty`,
  `test_a_clean_directory_reports_no_fallbacks`, and
  `test_an_undecodable_file_falls_back_and_reports_it`, and both are
  mutation-checked.

### Not planned for the viewer, and why

- **Virtualising the grid** and **"load more" paging** are unnecessary once
  thumbnails ship: 491 thumbnails is ~1.1 MB, so the cost stops being
  proportional to collection size. Adding either would be complexity bought for
  a problem that is no longer there.
- **Streaming the bridge reply per image** was the fourth strategy considered.
  With thumbnails the transient is one 47 MB decode rather than a 128 MB string,
  so it is no longer worth a protocol change.
- **Fetching originals on demand** (rather than the scan sending a path and the
  frontend requesting bytes per image) is the fuller version of TODO-088 and
  would also cap what a very large single image costs to open. It needs a new
  per-image fetch binding, which is the same native transport work as TODO-036,
  so it is left out here rather than half-done.

## Splitting the two files that grew past what they should be

An audit of line counts against the "a file over 1000 lines has stopped being
readable" threshold found **five files over it, all frontend**. The backend has
none: 26 C files, largest `src/json_io.c` at 658, which is under two thirds of
the threshold and not the problem this section is about.

**Everything in this section is a maintenance change, not a behavior change.**
Four of the five are refactors whose value is that the next person can read them;
the fifth, `map-viewport.js`, was examined and deliberately left alone. The one
thing here that is *not* a refactor is a pair of bugs the move exposed.

| File | Before | After |
|------|--------|-------|
| `src/App.vue` | 2008 | 438 |
| `src/index.css` | 2871 | 37 + 10 partials |
| `tests/map-explorer.test.js` | 1552 | 3 files, 287/720/505 |
| `tests/toc-outline.test.js` | 1113 | 3 files, 612/153/437 |
| `src/map-viewport.js` | 1011 | 1011 — see below |

**`App.vue` was the one that mattered**, not because it was the largest but
because it is the composition root every future feature touches, so it compounds.
The template split cleanly by pane and the five `data-view` sections became
components, each importing the session modules it reads directly rather than
taking state through props. The script split was the second half and the risky
one, so it went second: 279 lines of pane-local handlers that had moved were
deleted and the import list pruned from 372 names to what the shell still uses.

**`map-viewport.js` was left alone, deliberately.** It is the module extracted in
TODO-093 to remove 476 lines of duplication between the two viewers, and it is
1011 lines because its comments explain why each piece is the way it is. It has
eleven clean sections, so it could be split — but pan, zoom, the tile set, the
rate floor, and the gesture handlers are one state machine, and splitting them
would re-create exactly the seams the extraction removed. It is 11 lines over a
threshold that is a smell, not a law. Recorded here rather than quietly left
alone.

### Two bugs the split found, both of which had been failing silently

The template-binding check had been reporting two unresolved names before this
work started, and this is what they were:

- **`googleMapCenter`** was used in the Google viewer's toolbar and never
  imported, so Vue resolved it to `undefined` and the centre label rendered
  `formatCoordinates(undefined)` — literally the words **"No location"**, on a
  viewer whose whole purpose is showing where you are.
- **`mapSize`** was used by the GeoJSON overlay's `viewBox` and never imported, so
  the SVG carried `0 0 undefined undefined`.

Neither had been visible because neither throws. A test file was failing about
them the whole time, and it was failing about *exactly* this.

### What the split cost, and the two places it bit

- **One pane-local dependency did not survive the move.** `persistenceMode`
  belongs to the engine instance `App.vue` constructs and is not a module export,
  so it could not simply be imported. It is now a prop on `EditorPane` — explicit,
  and honest about the direction of the dependency. The phrase that goes with it
  became `saveLabelFor()` in the persistence module, because the shell's badge
  and the editor's status bar must not describe the same mode differently.
- **`scheduleWorkspaceSave` had the same problem** and got the other answer: a
  module-level delegate registered once at boot, following the singleton pattern
  every other session already uses, rather than a prop carrying a function.

The two tests that read `App.vue` as text now read the whole component set, and
`tests/support/styles.mjs` does the same for the stylesheet — because a contract
check that no longer follows the code it constrains protects nothing. As a
side-effect, **twelve previously failing tests now pass**: the component-dom
editor/TOC/menu suite and the template-binding suite, which had been red on
`main`.

**One false positive to expect again:** biome's `noDescendingSpecificity` now
fires inside `map-places.css` because it reads one file at a time and cannot see
that the base `.toolbar-button` rules are in `shell.css`, which the cascade
reaches first. It is suppressed inline with that reason written down, because a
suppression with no reason is the thing this whole section is arguing against.

## Reconciling the record with the tree

A whole-codebase pass, asking one question of every claim: does the code do
this? It found that the *project* is in good shape and its *bookkeeping* is not.
The backend is well-factored and all three layers build and pass; every
substantive mismatch was in a document describing code that had moved.

**The one that mattered.** `TODO-038` was marked `— DONE` with the evidence
"`tests/map-explorer.test.js` and `tests/map-places.test.js` cover the debounce,
the stale-response guard, and the jump." None of those three things exists.
There is no place search in this project: `search` appears zero times in the
explorer, the viewport, the pane component, or the places session; there is no
search input in any pane template; there is no `nominatim` string in the tree.
It is reopened, and the reason is recorded as a defect rather than a typo — a
`— DONE` marker is a promise the next contributor trusts, and fabricated evidence
under one does not merely misdescribe the past, it invites new work to be built on
an assumption nobody tested.

**Why it stayed hidden for so long.** The claim propagated into
`PYRAMID-OF-INTENTS.md` I1.6 and `docs/overview.md`, so a reader checking the
intent document would have concluded the feature shipped. The intent pyramid is
what the backlog justifies itself against, so a false claim there is worse than
one in a README. I1.6 is amended: place search is out of scope, because a
geocoder is a network client and a page-side one would be a *second* crossing of
I1.2. If search is wanted it belongs to the native transport in TODO-036.

**A live bug, not just a stale document.** `src/smoke.js` asserted five menu
cards and five pane anchors while the launcher rendered six. That check only runs
under `make smoke-test`, which needs a graphical session, so the disagreement was
invisible to CI and would have failed on a developer's desktop instead. Fixed, and
`tests/menu-cards.test.js` now makes the same comparison in the ordinary test run.

### The bug underneath all of it: `<StatusLine>` was never imported

Wired up as part of the earlier pane extraction and found while fixing the
documentation: **six pane components used `<StatusLine>` without importing it.**
Vue does not report an unresolved component — it renders an unknown element. So
`<StatusLine :message="m" />` became `<statusline message="m">`, and:

- the message became an **attribute** rather than text, so every status line in
  every pane showed the reader nothing;
- the `role="status"` and `aria-live` the component exists to provide never
  rendered, so nothing was announced to a screen reader either.

Five files affected: `TocPane`, `ImagesPane`, `PdfPane`, `MapPane`,
`GoogleMapPane`. Fixed, and `tests/menu-cards.test.js` now asserts that every
capitalised component a template renders is imported by that component.

**Why it survived, and why that is the part worth keeping.** The shell tests
assert that status *ids* and *anchors* exist, and `<statusline>` has them. Nothing
anywhere asserted the element was the right one — so a test suite of 500-odd
assertions could be green while every error message in the app was invisible to
the person it was written for. A test that would have caught it has to name the
thing that broke, not a proxy for it.

### The four guards added

Each one exists because the corresponding drift happened and would happen again.
A document is not a thing that fails loudly when it is wrong. These turn three
silent mismatches and one silent rendering failure into red tests.

| Test | Guards |
| --- | --- |
| `tests/menu-cards.test.js` | `MenuView.vue`, `public/index.html`, `VIEWS`, and `smoke.js` agree on how many tools there are and which pane each card opens |
| `tests/bridge-bindings.test.js` | the 14 bindings `webview_app.c` registers, what `docs/bridge-protocol.md` documents, and what the protocol does not claim — read as text, because `webview_app.c` pulls in GTK and cannot be imported |
| `tests/menu-cards.test.js` (second case) | every capitalised component a pane template renders is imported by that pane — the `<StatusLine>` failure above |
| `tests/readme-map.test.js` | every tracked source file appears in the README's repository map, nothing in it is missing, and a suite file is in `tests/MANIFEST` rather than orphaned |

Also fixed, smaller: the repository map listed 20 of 34 native and test files,
omitting the entire outline-PDF and text-transfer halves of the bridge; the README
described six bindings as "the" bindings when there are fourteen; and
`docs/architecture.md` still said `App.vue` "renders the template", which stopped
being true when the panes were extracted.

**What was deliberately not changed.** The five-tool wording became six-tool
because six is what renders. The alternative — deleting the Google viewer — would
also resolve TODO-094's licensing question in one stroke, and that is a product
decision rather than a documentation fix, so it is left open.

## Backlog rules

- Do not add a TODO without an `Intent:` line.
- Prefer one outcome per TODO; split unrelated work.
- Update the intent pyramid when the product boundary or architecture changes.
- Close a TODO only with evidence: a test, build result, documented manual
  check, or an explicit reason the intent no longer applies.
- Use `— DONE` when the work shipped with evidence, and `— CLOSED` when it no
  longer applies and the reason is recorded.
