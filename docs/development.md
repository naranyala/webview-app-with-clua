# Development guide

## Prerequisites

For the C and Lua paths:

- C11 compiler
- GNU Make
- Lua 5.4 development headers and pkg-config metadata

Lua 5.3 may work, but the build currently prefers `lua5.4`. Override it when
necessary:

```sh
make LUA_PKG=lua5.3 LUA=lua5.3 test
```

For the desktop path:

- CMake 3.16 or newer
- C++ compiler
- GTK 3 development files
- WebKitGTK 4.1 development files
- Poppler command-line tools (`pdftotext`) for heading extraction
- network access for the first WebView dependency fetch, unless cached

For the frontend:

- Node.js
- npm

On Debian/Ubuntu, a typical native setup is:

```sh
sudo apt install build-essential cmake g++ pkg-config \
  lua5.4 liblua5.4-dev libgtk-3-dev libwebkit2gtk-4.1-dev poppler-utils
```

## Install frontend dependencies

```sh
cd frontend-vue
npm install
cd ..
```

## Main build system

[`build.lua`](../build.lua) is the project-wide build orchestrator. It installs
frontend dependencies when needed, builds the Lua native module, configures and
builds the CMake WebView desktop target, and exposes test and cleanup commands.
[`run.sh`](../run.sh) delegates to it.

```sh
lua build.lua all          # native module + Vue desktop application
lua build.lua desktop      # Vue frontend + native WebView executable
lua build.lua native       # Lua native module compiled through build.lua
lua build.lua c-tests      # compile standalone C test executables
lua build.lua frontend     # Vue single-file HTML only
lua build.lua test         # frontend, C, Lua, bridge, and sanitizer tests
lua build.lua doctor       # report required tool availability
lua build.lua clean        # remove build output
./run.sh                   # build everything and launch the desktop app
```

The Lua build helpers in `build.lua` can compile future C shared libraries
and executables with reusable include paths, defines, compiler flags, libraries,
and pkg-config dependencies. The existing Lua module and standalone C tests
use those helpers.

Override `BUILD_TYPE`, `METRICS_ENABLE_DEVTOOLS`, `METRICS_RENDER_MODE`, `LUA`,
or `LUA_PKG` through the environment when needed.

The sanitizer target defaults to Clang because some GCC installations do not
ship a usable sanitizer runtime. Override it with `SANITIZER_CC=...`.

The desktop build enables WebView developer tools by default. Disable them for
a release-style build with:

```sh
cmake -S . -B build/desktop -DMETRICS_ENABLE_DEVTOOLS=OFF
```

On GTK/WebKit, developer tools are typically available from the WebView
context menu or the backend's standard inspector shortcut.

The generated frontend HTML is registered as a CMake build output. Re-running
`./run.sh` or `make desktop` reuses the cached WebView checkout, frontend
bundle, and native objects when their inputs have not changed. The frontend is
rebuilt only when one of its source, configuration, or package files changes.

`run.sh` builds the frontend and the desktop host loads the contents of the
generated `frontend-vue/dist/index.html` directly into WebView. No frontend
server is required. This is the default because it reliably executes the
bundled script in WebKit. To force local-file navigation instead, use:

```sh
METRICS_RENDER_MODE=file ./run.sh
```

For direct CMake launches, the same `file://` strategy is used when no
frontend URL is supplied. If local-file navigation fails, the host falls back
to reading the artifact and injecting it with `webview_set_html`.

## Build outputs

Generated artifacts are under ignored paths:

- `build/native/metrics.so` — Lua native module.
- `build/test_metrics` — C engine test executable.
- `build/test_bridge` — bridge parser test executable.
- `build/test_workspace_store` — workspace store test executable.
- `build/sanitized/` — sanitizer test executables.
- `build/desktop/bin/metrics_desktop` — desktop application.
- `frontend-vue/dist/index.html` — self-contained Vue frontend artifact.

## Troubleshooting

### Lua development files not found

The Makefile uses `pkg-config` to find Lua flags. Check available package
names with:

```sh
pkg-config --list-all | grep -i lua
```

Then pass the matching package name using `LUA_PKG=...`.

### Frontend submits but cannot calculate

The native bridge is present only in the desktop WebView application. The
ordinary `npm run dev` page intentionally reports that the bridge is
unavailable.

### Desktop build cannot fetch WebView

The CMake configuration fetches WebView 0.12.0 through `FetchContent`. Check
network access or make the dependency available in the CMake cache before
retrying.

### `Could not create WebView`

This message occurs before the generated HTML is loaded. Check that a graphical
session is available and that `DISPLAY` or `WAYLAND_DISPLAY` points to an
accessible session. Confirm the GTK/WebKit runtime with:

```sh
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0
ldd build/desktop/bin/metrics_desktop | grep 'not found'
```

The host also reports the failing WebView stage (`set_html`, `bind summarize`,
or `run`) and its WebView error code. This distinguishes a native window/runtime
problem from a frontend bundle problem.

The host also installs a small diagnostic script before loading the page. A
frontend JavaScript exception or unhandled promise rejection is logged to the
terminal and displayed inside the WebView, instead of leaving only the page
background visible.

That bootstrap also polyfills `Object.hasOwn`, which is used by WebView 0.12's
binding bootstrap but is missing in some WebKit JavaScript runtimes. Without
the polyfill, the UI can render while `window.summarize` is never installed.

With WebView 0.12 on GTK, `set_size` may report error code `-2` after applying
the requested size because of an upstream fall-through bug. The host logs this
as a warning and continues loading the frontend.
