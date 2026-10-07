# C-powered Lua WebView starter

A working desktop application that demonstrates one thing clearly: **how to put
correctness-critical state and computation in C, keep two presentation surfaces on
top of it, and have the boundary between them stay honest.**

The native layer owns state, validation, and persistence. Two consumers sit on top
of it and share none of their code:

- **Lua**, for programmatic workflows.
- **WebView + Vue**, for the desktop UI.

The sample native capability is a batch metrics engine — count, sum, minimum,
maximum, mean, and population variance from finite `double` values, computed with
Welford's algorithm so the result stays correct for inputs whose sum would lose
precision.

---

## The desktop application

Six tools over **one persisted record**:

| Tool | What it is for |
| --- | --- |
| **TOC Manager** | The outline. Declare sections, import headings from a PDF, reorder, undo. |
| **Text Editor** | A draft bound to a selected section. Autosaved per keystroke. |
| **PDF Reader** | Paged reader with a heading sidebar, session restore, and combined-outline export. |
| **Image Viewer** | Grouped thumbnail grid with a full-screen lightbox. |
| **Map Explorer** | OpenStreetMap tiles, saved places, distance and bearing between them, locate. |
| **Google Maps** | A second, render-only tile viewer, plus Google-URL place parsing and GeoJSON export. |

The six are not isolated screens. One record owns the outline, its drafts, each
tool's session, and the last view; an outline item can point at a PDF page, an
attached image, or a saved place; the menu cards show live badges; and a restart
restores where you were.

**Durability lives in C.** The host writes
`$XDG_DATA_HOME/native-workspace/workspace.json` atomically — temporary file,
`fsync`, `rename`, directory `fsync`, 4 MiB cap — through
[`src/workspace_store.c`](src/workspace_store.c). The frontend adopts it through
the `loadWorkspace` binding on boot, and WebView `localStorage` is only a
synchronous boot cache; whichever copy carries the newer `savedAt` wins. The
default inline render mode never persists WebView storage, so the file is the
durable copy.

> **The Google Maps viewer is unlicensed.** It fetches from
> `mt1.google.com/vt/lyrs=`, Google's internal raster endpoint, with no API key and
> no Maps Platform agreement. It is here because the pattern is worth
> demonstrating twice, not because it is permitted. TODO-094 is the open decision.

---

## Quick start

```sh
# 1. Install frontend packages
cd frontend-vue && npm install && cd ..

# 2. Check the toolchain, and build everything
lua build.lua doctor
./run.sh

# 3. Run everything
lua build.lua test
```

`./run.sh` delegates to `lua build.lua run`, and builds the frontend, the Lua
module, and the desktop host before launching. Prerequisites are in
[`docs/development.md`](docs/development.md).

| Command | What it does |
| --- | --- |
| `lua build.lua all` | Native module plus the Vue desktop application |
| `lua build.lua desktop` | Frontend bundle plus the native desktop executable |
| `lua build.lua native` | Lua native module only |
| `lua build.lua c-tests` | Compile the C test executables without running them |
| `lua build.lua test` | Everything: frontend, C, Lua, bridge, sanitizer |
| `lua build.lua doctor` | Report which tools and libraries are present |
| `lua build.lua smoke` | Launch the real app in both render modes and assert on it |
| `lua build.lua clean` / `distclean` | Remove build output / also remove the fetched WebView |

`make` is a thin wrapper over the same orchestrator, for the common targets
(`make test`, `make c-tests`, `make lua-test`, `make sanitized-test`,
`make smoke-test`, `make desktop`).

`make smoke-test` needs a graphical session (`DISPLAY` or `WAYLAND_DISPLAY`). It
isolates the durable workspace in a temporary directory, so it never touches real
data.

---

## Architecture

```text
   Lua scripts ──> lua/native/core.lua ──┐
                                         ├──> C metrics engine ──> summary
  WebView UI ─────> window.* bindings ────┘
        │                    │
        │                    └──> workspace store ──> workspace.json (atomic)
        │
        └── PDF / image / outline / text-transfer bindings ──> their C owners
```

The rule the whole project rests on: **the UI owns input and presentation; C owns
validation, state, and persistence.** A tool that reaches the network from the
page, or parses a host response itself, has crossed that line without saying so.

There is exactly one known crossing, and it is recorded rather than hidden: the
Map Explorer loads its tiles from the page (`<img src>`) rather than through a
native binding. That is TODO-035 and TODO-036.

The host registers **14 bindings**; `docs/bridge-protocol.md` documents each one,
and a test keeps the two lists from drifting.

`summarize` — the headline native capability — has **no production UI caller**. It
is kept for the Lua example, the bridge tests, and the desktop smoke test. That
is a deliberate property of a starter whose subject is the pattern rather than
the calculator, and both this file and `docs/overview.md` say so rather than
leaving a reader to discover it.

### To add a correctness-critical capability

1. Add the domain API and its tests to the C core.
2. Add only the Lua operations the scripts need.
3. Add only the WebView binding the UI needs.
4. Update the frontend and `docs/bridge-protocol.md` in the same change.
5. Test each boundary independently.

Do not move engine state into Lua tables or frontend JavaScript to avoid adding a
native contract.

---

## Repository map

Every tracked source file, grouped by layer. The point of listing all of them is
that a map which lists only the interesting files cannot answer "where does X
live" — which is the only reason to have one.
`frontend-vue/tests/readme-map.test.js` checks this list against the filesystem
in both directions, so a new module that is not listed fails the suite and a
listed file that has been deleted fails it too.

```text
--- native headers -------------------------------------------------
include/metrics.h              C metrics API
include/workspace_store.h      Durable workspace storage API
include/app_support.h          Shared native plumbing (context, JSON, pickers)
include/pdf_toc.h              PDF heading extraction and cache API
include/pdf_session.h          PDF webview bindings API
include/image_directory.h      Image directory binding API
include/workspace_bindings.h   Workspace webview bindings API
include/outline_pdf.h          Combined-outline PDF bindings API
include/text_transfer.h        Text read/write transfer bindings API
include/json_io.h              Shared JSON writer and request reader API
include/webview_bridge.h       summarize request parser API
include/smoke.h                Smoke verdict binding API

--- native core and bindings ---------------------------------------
src/metrics.c                  C engine and stable population variance
src/lua_metrics.c              Lua userdata binding
src/webview_bridge.c           Testable WebView request parser
src/webview_app.c              WebView host entry point and binding registry
src/json_io.c                  The single JSON writer and binding-request reader
src/app_support.c              Error replies, file URLs, pickers, GTK path chooser
src/workspace_store.c          Atomic workspace file store and request decoding
src/workspace_bindings.c       loadWorkspace and saveWorkspace bindings
src/pdf_toc.c                  PDF heading extraction, cache, serialization
src/pdf_session.c              openPdf, openPdfAt, extractPdfToc bindings
src/image_directory.c          openImageDirectory* and loadImageAt bindings
src/outline_pdf.c              chooseOutlineDirectory and renderOutlinePdf bindings
src/text_transfer.c            openTextFile and saveTextFile bindings
src/smoke.c                    smokeVerdict binding, present only under a smoke run

--- Lua surface (I1.4) ----------------------------------------------
lua/native/core.lua            Lua convenience API
lua/examples/demo.lua          The binding on its own
lua/examples/ui.lua            The minimal WebView surface (not loaded by the app)

--- build and desktop -----------------------------------------------
build.lua                      Main project build orchestrator
Makefile                       Thin wrapper over the same orchestrator
CMakeLists.txt                 Desktop target and WebView fetch
run.sh                         Entry point: delegates to build.lua
tools/tests-manifest.awk       Shared suite discovery for make, build.lua, ctest

--- tests ----------------------------------------------------------
tests/MANIFEST                The single declaration point for C suites
tests/test_metrics.c           C engine tests
tests/test_bridge.c            Bridge parser tests
tests/test_workspace_store.c   Workspace store tests
tests/test_json_io.c           JSON codec tests
tests/test_app_support.c       Shared plumbing tests
tests/test_pdf_toc.c           PDF heading extraction tests
tests/test_outline_pdf.c       Combined-outline PDF tests
tests/test_outline_roundtrip.c Outline-to-PDF round-trip, real tools
tests/test_image_directory.c  Directory scan tests
tests/test_text_transfer.c     Text transfer tests
tests/test_smoke.c             Smoke verdict decoding tests
tests/test_core.lua            Lua integration tests

--- frontend -------------------------------------------------------
frontend-vue/                  Vue desktop frontend and single-file build
  src/                         session modules, one pane component each, styles
  plugins/                     build plugin: worker inlining, CSP injection
  tests/                       node:test suites plus a jsdom harness for App.vue
  docs/                        frontend, testing, and map-source documentation
docs/                          Architecture, bridge protocol, development guides
PYRAMID-OF-INTENTS.md          Why the project exists, and the constraints
TODOS.md                       The backlog, every item linked to an intent
```

## Documentation

Start at [`docs/README.md`](docs/README.md).

| Guide | What it answers |
| --- | --- |
| [Overview](docs/overview.md) | Why the project exists, what it is for, what it is not |
| [Architecture](docs/architecture.md) | Who owns what, and the runtime sequence |
| [Intent pyramid](PYRAMID-OF-INTENTS.md) | The constraints, and the current verified state |
| [Bridge protocol](docs/bridge-protocol.md) | Every binding, its request shape, and its error vocabulary |
| [Development](docs/development.md) | Prerequisites, commands, outputs, troubleshooting |
| [Frontend](docs/frontend.md) | Module graph, the pane components, the build |
| [Testing](docs/testing.md) | Every test layer, and how to run all of it |
| [Map sources](docs/map-sources.md) | Tile hosts, the rate floor, attribution, and licensing |

---

## Requirements and limits

- **Desktop build needs a graphical session**, and the first build fetches WebView
  through CMake. The version is pinned to the upstream commit for tag `0.12.0`
  (`3ab4b5d722438fc8a13e6ca830c5e2372d19a01d`) rather than to the tag, so two
  clean builds a week apart resolve the same source — but it is still a first-use
  network dependency.
- **A plain browser preview has no native bindings.** All 14 exist only inside the
  desktop WebView host; workspace state falls back to `localStorage`, and the PDF,
  image, outline-PDF, and text-transfer features need the desktop app.
- **The Map Explorer has no place search.** A geocoder would be a second page-side
  network crossing, so search belongs to the native transport.
- **WebView developer tools are on by default** for inspecting the embedded
  frontend. Turn them off with `-DMETRICS_ENABLE_DEVTOOLS=OFF`.
- **The frontend depends on two runtime packages**, `vue` and `pdfjs-dist`. The map
  is hand-written: no mapping library, no build step beyond bundling.

## Project direction

Correctness-critical state and computation belong in C. Lua and WebView get small,
explicit contracts. Presentation code stays replaceable. New functionality
extends the C API first, adds boundary tests, and then exposes only what each
integration layer actually needs.
