# C-powered Lua WebView starter

A small desktop application pattern for building native capabilities in C,
orchestrating them from Lua, and presenting them through a self-contained
WebView UI.

The desktop UI is a local four-tool workspace - Text Editor, TOC Manager, PDF
Reader, and Image Viewer - sharing one persisted record: outline items link to
PDF pages and attached images, menu cards show live badges, and a restart
restores the last view, outline, buffer, reading position, and image selection.

The sample native capability is a batch metrics engine: the desktop
`window.summarize(values)` bridge and the Lua userdata binding both return
count, sum, minimum, maximum, mean, and population variance from finite
inputs.

## Quick start

Install the prerequisites described in [`docs/development.md`](docs/development.md),
then install frontend packages:

```sh
cd frontend-vue && npm install && cd ..
```

Run the Lua example:

```sh
make run
```

Build the native module and Vue desktop application:

```sh
lua build.lua all
```

Run the complete project build and launch the desktop application:

```sh
./run.sh
```

Run a build-system environment check:

```sh
lua build.lua doctor
```

Run the complete frontend, C, Lua, bridge, and sanitizer test suite:

```sh
lua build.lua test
```

## Workspace

- **Text Editor** - drafting column bound to an outline section, with a
  linked PDF page and attached images.
- **TOC Manager** - outline CRUD, PDF heading import, and outline folder
  migration.
- **PDF Reader** - paged reader with outline links, sessions, and a
  `Save to disk` sidepanel.
- **Image Viewer** - grouped grid with section attachments and a lightbox.

All four cards read and write one record. Durability lives in C: the host
writes `$XDG_DATA_HOME/native-workspace/workspace.json` atomically through
[`src/workspace_store.c`](src/workspace_store.c), the frontend adopts it
through the `loadWorkspace` binding on boot, and WebView `localStorage` stays a
synchronous boot cache - whichever copy carries the newer `savedAt` wins. The
default inline render mode never persists WebView storage, so the file is the
durable copy.

## Repository map

```text
include/metrics.h              C metrics API
include/workspace_store.h      Durable workspace storage API
src/metrics.c                  C engine and stable population variance
src/lua_metrics.c              Lua userdata binding
lua/native/core.lua            Lua convenience API
src/webview_bridge.c           Testable WebView request parser
src/workspace_store.c          Atomic workspace file store and request decoding
src/webview_app.c              WebView host and native binding
build.lua                      Main project build orchestrator
frontend-vue/                  Vue desktop frontend and single-file build
frontend-octane/               Legacy Octane frontend
tests/test_metrics.c           C engine tests
tests/test_bridge.c            Bridge parser tests
tests/test_workspace_store.c   Workspace store tests
tests/test_core.lua            Lua integration tests
```

The canonical desktop UI is `frontend-vue`. `frontend-octane` is retained as a
legacy frontend. `lua/app/ui.lua` is retained as
a small Lua-owned HTML example, but it is not used by the CMake desktop target.

## Architecture at a glance

```text
 Lua scripts ──> Lua binding ──┐
                              ├──> C metrics engine
   Vue UI ──> WebView bridge ┘          │
                                        ▼
                         summary or typed bridge error

   Vue UI ──> loadWorkspace / saveWorkspace ──> workspace_store.c
                                                   │
                                                   ▼
                          $XDG_DATA_HOME/native-workspace/workspace.json
```

Lua and WebView are separate consumers of the same native C core, and the
workspace file is its second native surface: a small, tested contract. The UI
owns input and presentation; C owns validation, state, and persistence.

## Documentation

- [Documentation index](docs/README.md)
- [Project overview](docs/overview.md)
- [Architecture and data flow](docs/architecture.md)
- [WebView bridge protocol](docs/bridge-protocol.md)
- [Development and build guide](docs/development.md)
- [Frontend guide](docs/frontend.md)
- [Testing guide](docs/testing.md)
- [Intent pyramid](PYRAMID-OF-INTENTS.md)
- [Intent-linked TODOs](TODOS.md)

## Current limitations

- The normal browser preview has no native bindings: `window.summarize`,
  `loadWorkspace`, `saveWorkspace`, `openPdf`, `extractPdfToc`, and
  `readTextFile` exist only inside the desktop WebView host. Workspace state
  falls back to `localStorage`, and PDF/image features need the desktop app.
- The first desktop build fetches the pinned WebView 0.12.0 dependency through
  CMake and requires network access unless that dependency is already cached.
- Subsequent desktop builds are incremental and reuse the cached WebView,
  frontend bundle, and native objects unless their inputs change.
- WebView developer tools are enabled by default for inspecting the embedded
  frontend; disable them with `-DMETRICS_ENABLE_DEVTOOLS=OFF` for release-like
  builds.
- `run.sh` loads the generated `frontend-vue/dist/index.html` contents
  directly into WebView; use `METRICS_RENDER_MODE=file ./run.sh` to test local
  file navigation instead.
- `make test` requires a discoverable Lua development installation; the C
  core, bridge, workspace store, and sanitizer targets are independent of Lua
  (`make workspace-test` runs the store tests alone).

## Project direction

Correctness-critical state and computation belong in C. Lua and WebView should
receive small, explicit contracts, and presentation code should remain
replaceable. New functionality should extend the C API first, add boundary
tests, then expose only the operations required by each integration layer.
