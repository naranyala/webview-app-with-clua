# Development guide

## Prerequisites

### C and Lua

- A C11 compiler
- GNU Make
- Lua 5.4 development headers and pkg-config metadata

Lua 5.3 works, but the build prefers `lua5.4`. Override when necessary:

```sh
make LUA_PKG=lua5.3 LUA=lua5.3 test
```

### Desktop

- CMake 3.16 or newer
- A C++ compiler
- GTK 3 development files
- WebKitGTK 4.1 development files
- Poppler command-line tools (`pdftotext`) for heading extraction
- Network access for the first WebView fetch, unless it is already cached

### Frontend

- Node.js and npm

On Debian and Ubuntu:

```sh
sudo apt install build-essential cmake g++ pkg-config \
  lua5.4 liblua5.4-dev libgtk-3-dev libwebkit2gtk-4.1-dev poppler-utils
```

Then install the frontend packages once:

```sh
cd frontend-vue && npm install && cd ..
```

## The build orchestrator

[`build.lua`](../build.lua) is the project-wide entry point. It installs frontend
dependencies when they are missing, builds the Lua native module, configures and
builds the CMake desktop target, and exposes the test and cleanup commands.
[`run.sh`](../run.sh) is a two-line wrapper that delegates to it, so there is one
build system rather than two that can disagree.

| Command | What it does |
| --- | --- |
| `lua build.lua all` | Native module plus the Vue desktop application |
| `lua build.lua desktop` | Frontend bundle plus the native desktop executable |
| `lua build.lua native` | Lua native module only |
| `lua build.lua frontend` | The single-file HTML artifact only |
| `lua build.lua c-tests` | Compile the C test executables without running them |
| `lua build.lua test` | Frontend, C, Lua, bridge, and sanitizer suites |
| `lua build.lua test-frontend` / `test-native` | One layer at a time |
| `lua build.lua smoke` | Launch the real app in both render modes and assert on it |
| `lua build.lua doctor` | Report which tools and libraries are present |
| `lua build.lua rebuild` | Clean, then build everything |
| `lua build.lua clean` / `distclean` | Remove build output / also remove the fetched WebView |
| `./run.sh` | Build everything, then launch the desktop app |

`make` wraps the common targets for convenience: `test`, `c-tests`, `lua-test`,
`sanitized-test`, `smoke-test`, `desktop`, `clean`, plus `check-*` probes that
report whether a single dependency is discoverable.

Override `BUILD_TYPE`, `METRICS_ENABLE_DEVTOOLS`, `METRICS_RENDER_MODE`,
`SANITIZER_CC`, `LUA`, or `LUA_PKG` through the environment.

The sanitizer target defaults to Clang, because some GCC installations do not
ship a usable sanitizer runtime. Override with `SANITIZER_CC=...`.

## The frontend on its own

```sh
cd frontend-vue
npm test        # 33 suites, no browser required
npm run check   # biome lint and format
npm run build   # one self-contained dist/index.html
npm run dev     # development server (no native bindings)
```

`npm run dev` intentionally has no bridge. That is the no-host path, and several
tests exercise it.

## The C test suites

Eleven suites, each declared **once** in [`tests/MANIFEST`](../tests/MANIFEST).
`Makefile`, `build.lua`, and `CMakeLists.txt` all read that file, so
`make test`, `lua build.lua test`, and `ctest` cannot disagree about what exists.
Adding a suite is a one-line edit.

Each row names a *profile* — the compile and link flags it needs — and a name that
becomes the binary, the make target, and the ctest name.

```sh
make c-tests            # compile all of them
make test               # compile and run them
make sanitized-test     # the same suites under a sanitizer
```

To run one suite, execute its binary directly — `make c-tests` builds all of them
into `build/`, and each exits non-zero on failure.

## Build outputs

All generated artifacts live under ignored paths:

| Path | What |
| --- | --- |
| `build/native/metrics.so` | Lua native module |
| `build/test_<name>` | One C test executable per manifest row |
| `build/sanitized/` | The same suites under a sanitizer |
| `build/desktop/bin/metrics_desktop` | The desktop application |
| `frontend-vue/dist/index.html` | The self-contained frontend artifact |

Incremental by default: re-running `./run.sh` or `make desktop` reuses the cached
WebView checkout, frontend bundle, and native objects when their inputs have not
changed. The frontend rebuilds when a source, config, or package file changes.

## How the desktop host loads the frontend

By default the host reads the contents of `frontend-vue/dist/index.html` and
injects it with `webview_set_html`. **No frontend server is required**, and this
is the default because it reliably executes the bundled script in WebKit.

To force local-file navigation instead:

```sh
METRICS_RENDER_MODE=file ./run.sh
```

The generated HTML is registered as a CMake build output, so the host is rebuilt
when it changes.

Developer tools are enabled by default for inspecting the embedded frontend.
Disable them for a release-style build:

```sh
cmake -S . -B build/desktop -DMETRICS_ENABLE_DEVTOOLS=OFF
```

## Troubleshooting

### Lua development files not found

The build finds Lua through `pkg-config`. List what is available:

```sh
pkg-config --list-all | grep -i lua
```

Then pass the matching package name: `LUA_PKG=...`.

### The UI works but nothing calls a binding

`npm run dev` has no native host, so `window.summarize`, `loadWorkspace`, and the
rest simply do not exist. The page reports the bridge as unavailable rather than
failing quietly. Use `./run.sh` for the real thing.

Two related symptoms are **not** bridge failures: a frontend exception at load, or
a UI that renders with `window.summarize` never installed. Both are logged to the
terminal and shown inside the WebView by a diagnostic bootstrap the host installs
before loading the page — the UI looking fine is not evidence the bridge is there.

### The desktop build cannot fetch WebView

CMake fetches WebView 0.12.0 through `FetchContent`, pinned to the commit
`3ab4b5d722438fc8a13e6ca830c5e2372d19a01d` so repeated clean builds resolve the
same source. Check network access, or pre-populate the CMake cache.

### `Could not create WebView`

This happens before the generated HTML is loaded, so it is a window or runtime
problem rather than a frontend problem.

```sh
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0
ldd build/desktop/bin/metrics_desktop | grep 'not found'
```

Confirm `DISPLAY` or `WAYLAND_DISPLAY` points at an accessible session. The host
reports the failing WebView stage (`set_html`, a named binding, or `run`) and its
error code, which is what distinguishes the two causes.

### The build passes but a test disagrees

`npm test` needs no browser and no host. If a frontend suite fails only when run
through CMake or the smoke test, the difference is almost always the DOM harness:
it installs `document` per test file rather than globally, precisely so the
no-host tests keep their own stubs. See [the testing guide](testing.md).

### WebView reports `set_size` error `-2`

An upstream fall-through bug in WebView 0.12 on GTK, after the requested size has
been applied. The host logs it as a warning and continues loading.
