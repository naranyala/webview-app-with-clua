# C-powered Lua WebView starter

A small desktop application pattern for building native capabilities in C,
orchestrating them from Lua, and presenting them through a self-contained
WebView UI.

The included capability is a batch metrics engine. Enter a list of finite
numbers in the desktop UI and the native C engine returns count, sum, minimum,
maximum, mean, and population variance. The same C core is available to Lua
through a thin userdata binding.

## Quick start

Install the prerequisites described in [`docs/development.md`](docs/development.md),
then install frontend packages:

```sh
cd frontend-octane && npm install && cd ..
```

Run the Lua example:

```sh
make run
```

Run the desktop application:

```sh
make desktop
```

Run tests that do not require Lua or WebView:

```sh
make core-test bridge-test sanitized-test
```

Run the complete test target once Lua development headers and pkg-config
metadata are installed:

```sh
make test
```

## Repository map

```text
include/metrics.h          C metrics API
src/metrics.c              C engine and stable population variance
src/lua_metrics.c          Lua userdata binding
lua/native/core.lua        Lua convenience API
src/webview_bridge.c       Testable WebView request parser
src/webview_app.c          WebView host and native binding
frontend-octane/            Octane frontend and single-file build
tests/test_metrics.c       C engine tests
tests/test_bridge.c         Bridge parser tests
tests/test_core.lua         Lua integration tests
```

The canonical desktop UI is `frontend-octane`. `lua/app/ui.lua` is retained as
a small Lua-owned HTML example, but it is not used by the CMake desktop target.

## Architecture at a glance

```text
 Lua scripts ──> Lua binding ──┐
                              ├──> C metrics engine
 Octane UI ──> WebView bridge ┘          │
                                        ▼
                         summary or typed bridge error
```

Lua and WebView are separate consumers of the same native C core. The UI owns
input and presentation; C owns validation, state, and computation.

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

- The normal browser preview cannot calculate metrics because the native
  `window.summarize` bridge exists only inside the desktop WebView host.
- The first desktop build fetches the pinned WebView 0.12.0 dependency through
  CMake and requires network access unless that dependency is already cached.
- Subsequent desktop builds are incremental and reuse the cached WebView,
  frontend bundle, and native objects unless their inputs change.
- WebView developer tools are enabled by default for inspecting the embedded
  frontend; disable them with `-DMETRICS_ENABLE_DEVTOOLS=OFF` for release-like
  builds.
- `run.sh` loads the generated `frontend-octane/dist/index.html` directly into
  WebView; force inline HTML injection with `METRICS_RENDER_MODE=inline ./run.sh`.
- `make test` requires a discoverable Lua development installation; the C
  core, bridge, and sanitizer targets are independent of Lua.

## Project direction

Correctness-critical state and computation belong in C. Lua and WebView should
receive small, explicit contracts, and presentation code should remain
replaceable. New functionality should extend the C API first, add boundary
tests, then expose only the operations required by each integration layer.
