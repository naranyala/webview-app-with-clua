# Pyramid of Intents

This document defines why the project exists, what it must enable, and the
constraints that should guide implementation decisions. `TODOS.md` is the
execution backlog; every backlog item must reference an intent ID from this
document.

## How to use this pyramid

- Keep the intent IDs stable. Add a new intent instead of silently changing
  the meaning of an existing one.
- When proposing work, identify the highest-level intent it serves.
- A TODO is valid only when it has an `Intent:` reference and a verifiable
  outcome.
- If a task conflicts with a higher-level intent, resolve the conflict here
  before implementing it.

## I0 — North-star intent

### I0.1 — Make native capabilities easy to build and easy to use

Provide a small, understandable desktop application pattern in which
performance-sensitive or correctness-critical logic lives in native C, Lua
can orchestrate behavior, and a WebView UI can evolve independently without
losing a simple build and runtime model.

**Success looks like:** a contributor can understand the data flow, run the
tests, launch the desktop app, and safely add a native capability without
rewriting the UI architecture.

## I1 — Product intents

### I1.1 — Demonstrate a useful native capability

The example capability is batch metrics over a finite sequence of numbers.
Users should be able to enter samples and receive a trustworthy summary.

### I1.2 — Make the boundary between UI and native code explicit

The frontend should communicate with native code through a small, documented
bridge. The UI must not depend on implementation details of the C engine. A
tool that reaches the network from the page, or parses a host response itself,
has crossed this boundary without saying so — the Map Explorer's tile fetch is
the open case.

### I1.3 — Keep the project approachable as a starter template

The project should favor clear code paths, modest dependencies, reproducible
commands, and documentation that matches the code that actually runs.

### I1.4 — Preserve multiple integration surfaces intentionally

Lua remains the scripting/integration surface for programmatic workflows, and
WebView remains the desktop presentation surface. They may share the C core,
but neither should be accidentally presented as the other.

### I1.5 — Treat the menu tools as one workspace

The Text Editor, TOC Manager, PDF Reader, and Image Viewer are not isolated
screens. They share one persisted workspace: the declared outline and its
drafts, the last view, the open document session, and the selected image
folder all survive a restart, and any tool may reference content owned by
another (an outline item pointing at a PDF page or an attached image). The
Map Explorer of **I1.6** joined that same record rather than starting a second
one.

**Success looks like:** a contributor can point at one store that owns the
cross-tool state, and a user can move from outline to source document and back
without re-declaring or re-losing anything.

### I1.6 — Add an OpenStreetMap explorer as a map tool

The grid opens a map: pan-and-zoom raster tiles, named bookmarks that survive a
restart, and current-location lookup. The WebView page must not reach tile
servers itself, so tiles and location arrive through narrow native bindings that
fetch over allowlisted HTTPS, rate-limit, and cache on disk.

**Success looks like:** a user opens the explorer, pans to a place, bookmarks it,
locates themselves, and finds both the bookmarks and the last position after a
restart — with attribution and usage-policy limits visible in the docs.

**Amended 2026-10-06, and the amendment is the point.** This intent previously
listed "a basemap switcher, place search" among the explorer's features. Neither
exists: the Explorer has a *colour filter* over one basemap, not a switcher, and
there is no place search anywhere in the tree. TODO-038 had been marked `— DONE`
with evidence describing a search debounce and a stale-response guard that were
never written, and this intent was where that error became invisible. Two changes
follow:

- **Place search is not required, and is deliberately out of scope here.** A
  geocoder is a network client, so a page-side one would be a second crossing of
  **I1.2** — the same crossing the tile fetch already is. If search is wanted it
  belongs to the native transport in TODO-036, and this intent should be amended
  again at that point rather than the page growing a geocoder.
- **A basemap switcher is a separate question** from a colour filter, and only
  the Google viewer has one. Whether the Explorer grows a real switcher is a
  product decision, recorded as open in TODO-038.

The intent IDs stay stable; this entry states more precisely what was meant.

## I2 — User intents

### I2.1 — A user can calculate metrics from the desktop UI

The user enters comma-separated numbers, submits them, and sees count, sum,
mean, variance, minimum, and maximum.

### I2.2 — A user receives useful feedback for invalid input

Empty input, blank tokens, non-numeric values, infinities, and other rejected
requests must produce a clear, actionable message.

### I2.3 — A user can trust the displayed result

The UI must show which calculation was performed, use stable number formatting,
and avoid presenting a partial or stale result as current.

### I2.4 — A developer can run and extend the example quickly

The README, build targets, tests, and source layout should agree on the
supported workflows.

### I2.5 — A user does not lose work when switching tools or restarting

Selecting an outline item, writing a section, attaching a source document or
image, and reopening the application must keep the outline, the drafts, and
the session context intact instead of resetting to an empty shell.

## I3 — System intents

### I3.1 — Keep computation in the C core

The metrics engine owns sample storage, validation, lifecycle, and summary
calculation. It must not depend on Lua, WebView, or frontend concerns.

### I3.2 — Expose a narrow Lua API

Lua receives an owned engine handle with operations to create, add, summarize,
and reset. Native memory must be released through the userdata lifecycle.

### I3.3 — Expose a narrow WebView API

The desktop host exposes one stable operation, currently `summarize`, accepting
the WebView-generated request shape and returning structured JSON.

### I3.4 — Make failures bounded and observable

Malformed requests, non-finite values, empty datasets, allocation failures, and
frontend bridge failures should fail without leaks or undefined behavior and
should provide enough information to diagnose the problem.

### I3.5 — Keep the desktop artifact self-contained

The production frontend should build to a single HTML file with inlined assets,
so the WebView host does not require a local HTTP server or asset directory.

## I4 — Quality and evolution intents

### I4.1 — Test behavior at each boundary

The C core, Lua binding, WebView request parser, and frontend interaction should
have proportionate automated or repeatable verification.

### I4.2 — Prefer numerically sound statistics

The implementation should remain correct for ordinary inputs and should avoid
avoidable precision loss, overflow, and negative-zero surprises as the example
becomes more realistic.

### I4.3 — Make compatibility and dependency assumptions explicit

Supported Lua versions, WebView versions, platform requirements, Node tooling,
and network requirements for first-time builds should be documented and checked.

### I4.4 — Keep the architecture replaceable at the seams

The metrics engine, Lua wrapper, bridge protocol, and frontend should be
changeable independently behind small contracts.

## Current state snapshot

Verified against the tree and a full test run on 2026-10-06, rather than against
these entries. Every claim below was checked by running it.

Already present and working:

- C metrics engine with lifecycle, validation, reset, and summary operations. The
  variance is Welford's algorithm, so it stays correct for values whose sum would
  lose precision - **I4.2**, not a claim about it.
- Lua userdata binding and Lua convenience wrapper. `make lua-test` passes here.
- C WebView host registering **14 bindings**, of which `summarize` has no
  production UI caller. It is kept for the Lua example, the bridge tests, and the
  smoke test, which is stated in the README rather than left for a reader to
  discover.
- Vue frontend: six tools on one shared workspace record, one component per pane,
  the map split into a shared viewport and two thin sessions.
- Durable C-owned workspace store — temp file, fsync, atomic rename, directory
  fsync, 4 MiB cap — so state survives the inline render mode. `localStorage` is
  only a boot cache and loses to the file on `savedAt`.
- 11 C suites declared once in `tests/MANIFEST` and read by `make`, `build.lua`,
  and CMake alike; 17 C test binaries build and pass here, plus the Lua suite and
  30 frontend suites.
- A single-file build with a Content-Security-Policy injected at build time,
  whose `img-src` names the tile hosts and whose `script-src` carries a hash of
  the inlined bundle.

Known gaps, in the order they should be closed:

- **The Map Explorer loads tiles from the page, not through a native binding.**
  This is the one place **I1.2** is not held, and it is why I1.6 could not
  promise a geocoder either. TODO-035 and TODO-036.
- **The Google viewer uses an unlicensed endpoint.** `mt1.google.com/vt/lyrs=`
  with no API key and no Maps Platform agreement, named in the shipped CSP
  allowlist because that is a statement about reachability, not permission.
  TODO-094.
- **`summarize` has no production UI path.** The headline native capability is
  exercised by Lua, the bridge tests, and the smoke test, and by nothing a user
  touches. That is acceptable for a starter whose subject is the pattern rather
  than the calculator, but it should be a decision, not an accident.
- **Six pane components rendered `<StatusLine>` without importing it**, so every
  status line in the app showed nothing and announced nothing — the message became
  an attribute on an unknown element. Vue does not report an unresolved component,
  and the shell tests assert ids and anchors, which `<statusline>` satisfies, so
  nothing caught it. Fixed; `tests/menu-cards.test.js` now checks that every
  capitalised component a template renders is imported by that template's file.
- **The GUI smoke test needs a graphical session and CI has no workflow for
  running it.** That gap is why the menu-card count could sit at 5 while the app
  rendered 6 for as long as it did: the only place that compared them was the one
  place CI does not run. The comparison now also happens in `npm test`
  (`tests/menu-cards.test.js`, `tests/bridge-bindings.test.js`,
  `tests/readme-map.test.js`), which is the fix that actually holds.
- **The frontend has no mounted component test for the map, the reader, or the
  lightbox.** The map has extensive session-level tests; the panes do not have
  jsdom coverage.
- **The first desktop build fetches WebView through CMake**, pinned to a commit
  rather than a tag, so two clean builds resolve the same source — but it is still
  a first-use network dependency. TODO-010.
- **The frontend cannot reach the native bindings in a plain browser preview**, by
  design. Workspace state falls back to `localStorage`.

**One thing this snapshot exists to prevent.** Earlier it listed a five-tool
workspace and a Map Explorer with "a basemap switcher, place search". None of that
was true: there are six tools, the Explorer has a colour filter rather than a
switcher, and there is no place search anywhere in the tree — while `TODOS.md`
carried a `— DONE` marker whose evidence described a search debounce and a
stale-response guard that were never written. A document that describes intent can
be aspirational; a document labelled *current state* cannot, and it is the label
that makes people stop checking.
