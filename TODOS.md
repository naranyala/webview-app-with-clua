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

### TODO-002 — Add a repeatable desktop smoke test

- **Intent:** I1.1, I1.2, I2.1, I4.1
- **Priority:** P0
- **Work:** Define a smoke-test path that builds the frontend and desktop host,
  invokes the bridge with representative values, and verifies the displayed
  summary or the bridge response.
- **Done when:** CI or a documented local command proves that the actual
  frontend-to-C path works, not just that each component compiles.

### TODO-003 — Keep frontend, bridge, and documentation contracts synchronized — DONE

- **Intent:** I1.2, I1.3, I3.3, I4.4
- **Priority:** P0
- **Work:** Document the `summarize` request/response contract and remove or
  clearly label any legacy Lua-generated UI path that is not part of the
  desktop build.
- **Done when:** A contributor can identify one authoritative desktop UI path,
  its request shape, its response shape, and its error behavior.
- **Evidence:** The contract is documented in `docs/bridge-protocol.md`; the parser is
  separated into `src/webview_bridge.c`; the desktop build uses the Octane
  frontend as its authoritative UI.

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

### TODO-007 — Harden lifecycle and allocation failure paths

- **Intent:** I3.1, I3.2, I3.4, I4.1
- **Priority:** P1
- **Work:** Audit repeated destruction, Lua garbage collection, failed userdata
  allocation, and all early-return paths for leaks or use-after-free risks.
- **Done when:** Sanitizer or equivalent checks cover the C core and Lua binding,
  and lifecycle behavior is documented.

### TODO-008 — Add frontend behavior tests — DONE

- **Intent:** I2.1, I2.2, I2.3, I4.1
- **Priority:** P1
- **Work:** Test parsing, invalid-token handling, loading state, successful
  rendering, native error rendering, and missing-bridge behavior with a mocked
  `window.summarize`.
- **Done when:** A frontend test command runs without a desktop WebView and
  verifies the user-visible states.
- **Evidence:** `frontend-octane/npm test` covers input parsing, bridge error
  decoding, formatting, and summary rendering through `src/metrics-ui.js`.

## P2 — Improve portability and contributor experience

### TODO-009 — Add a CI matrix for core, Lua, and frontend workflows

- **Intent:** I1.3, I2.4, I4.1, I4.3
- **Priority:** P2
- **Work:** Run C tests, Lua integration tests, frontend formatting/build, and
  where practical the desktop compile on supported Linux configurations.
- **Done when:** Pull requests automatically detect broken contracts or build
  assumptions.

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
- **Work:** Show the data flow from Octane input to WebView binding to C parser
  to metrics engine and back to the result view; show Lua as a separate path.
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

### TODO-013 — Support file or pasted multiline input

- **Intent:** I1.1, I2.1, I2.2
- **Priority:** P3
- **Work:** Define whether whitespace/newlines are valid separators and extend
  the UI and bridge contract accordingly.
- **Done when:** The grammar is documented, tested, and errors identify the
  offending input when possible.

### TODO-014 — Add export/copy of the summary

- **Intent:** I2.1, I2.3
- **Priority:** P3
- **Work:** Provide a copy-to-clipboard or JSON export action without changing
  the native computation contract.
- **Done when:** Users can copy the displayed result and receive feedback that
  the action succeeded or failed.

### TODO-015 — Add a second native capability as a seam-validation exercise

- **Intent:** I0.1, I1.4, I3.1, I4.4
- **Priority:** P3
- **Work:** Add a small independent operation, such as percentile or a moving
  average, through the C API, Lua wrapper, bridge, and UI only if the existing
  contracts remain narrow.
- **Done when:** The new capability has C tests, Lua coverage, bridge coverage,
  and frontend coverage without duplicating engine ownership logic.

## Backlog rules

- Do not add a TODO without an `Intent:` line.
- Prefer one outcome per TODO; split unrelated work.
- Update the intent pyramid when the product boundary or architecture changes.
- Close a TODO only with evidence: a test, build result, documented manual
  check, or an explicit reason the intent no longer applies.
