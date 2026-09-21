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
- network access for the first WebView dependency fetch, unless cached

For the frontend:

- Node.js
- npm

On Debian/Ubuntu, a typical native setup is:

```sh
sudo apt install build-essential cmake g++ pkg-config \
  lua5.4 liblua5.4-dev libgtk-3-dev libwebkit2gtk-4.1-dev
```

## Install frontend dependencies

```sh
cd frontend-octane
npm install
cd ..
```

## Common commands

| Command | Purpose |
| --- | --- |
| `make run` | Build the Lua module and run the Lua demo. |
| `make core-test` | Build and run C engine tests. |
| `make bridge-test` | Build and run bridge parser tests. |
| `make test` | Run C, bridge, and Lua tests. |
| `make sanitized-test` | Run C and bridge tests with ASan/UBSan. |
| `make desktop` | Build the frontend and native WebView app, then launch it. |
| `./run.sh` | Equivalent desktop launcher using an explicit project path. |
| `npm run build` | Build the standalone frontend HTML. |
| `npm run dev` | Start the frontend development server. |
| `npm run check` | Run Biome checks. |
| `make clean` | Remove generated native build output. |

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

`run.sh` serves the generated page from a loopback HTTP server and the desktop
host navigates to `http://127.0.0.1:4173/index.html`. This avoids both local
file restrictions and copying the large HTML string into the WebView. To force
the inline strategy, use:

```sh
METRICS_RENDER_MODE=inline ./run.sh
```

For direct CMake launches, the host uses `file://` navigation when no frontend
URL is supplied. It falls back to inline HTML if navigation fails. Change the
loopback port with `METRICS_HTTP_PORT=...`.

## Build outputs

Generated artifacts are under ignored paths:

- `build/native/metrics.so` — Lua native module.
- `build/test_metrics` — C engine test executable.
- `build/test_bridge` — bridge parser test executable.
- `build/sanitized/` — sanitizer test executables.
- `build/desktop/bin/metrics_desktop` — desktop application.
- `frontend-octane/dist/index.html` — self-contained frontend artifact.

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

With WebView 0.12 on GTK, `set_size` may report error code `-2` after applying
the requested size because of an upstream fall-through bug. The host logs this
as a warning and continues loading the frontend.
