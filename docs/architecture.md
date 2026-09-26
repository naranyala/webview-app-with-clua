# Architecture and data flow

## Component map

```text
                         programmatic path
      Lua script ──> lua/native/core.lua ──> native.metrics
                                                │
                                                ▼
                                      C metrics engine
                                                ▲
                                                │
      Octane UI ──> window.summarize ──> WebView binding
                         presentation path       │
                                                  ▼
                                         webview_bridge.c
                                                  │
                                                  ▼
                                      C metrics engine
```

The two consumers share the engine implementation but do not share UI or
workflow code.

## Ownership rules

### C metrics core

[`src/metrics.c`](../src/metrics.c) owns the opaque `metrics_engine` state. It
stores count, sum, running mean, running second moment, minimum, and maximum.
The public API is declared in [`include/metrics.h`](../include/metrics.h).

The core rejects non-finite values and rejects additions whose arithmetic would
overflow. A rejected value does not change the engine state.

### Lua binding

[`src/lua_metrics.c`](../src/lua_metrics.c) wraps the C pointer in Lua
userdata. Lua owns the handle reference; the `__gc` metamethod releases the C
engine. [`lua/native/core.lua`](../lua/native/core.lua) adds the convenience
`metrics.from(values)` function.

### Desktop host

[`src/webview_app.c`](../src/webview_app.c) loads the generated HTML file,
creates the WebView, binds `summarize`, and runs the event loop. It does not
embed Lua. The CMake desktop target links the metrics core and bridge parser
directly.

### Workspace store

[`src/workspace_store.c`](../src/workspace_store.c) owns durable frontend state.
It reads and writes `g_get_user_data_dir()/native-workspace/workspace.json`
through a temporary file and an atomic rename, enforces a 4 MiB payload cap,
and decodes the `saveWorkspace` binding argument. The host exposes it as the
`loadWorkspace` and `saveWorkspace` bindings; WebView storage is only a
synchronous boot cache because the inline render mode never persists it.

### Frontend

[`frontend-vue/src/App.vue`](../frontend-vue/src/App.vue) owns reactive view
switching, input parsing, loading/error states, PDF/TOC presentation, and result
rendering. It does not calculate metrics itself. The production build inlines
its assets into `frontend-vue/dist/index.html`.

## Runtime sequence

1. CMake runs the frontend build.
2. The WebView host reads the generated `index.html` into memory.
3. Vue renders the workspace menu and selected tool.
4. The user submits comma-separated values.
5. The frontend calls `window.summarize(values)`.
6. WebView serializes the argument list and invokes the C callback.
7. `webview_bridge.c` parses and validates the request.
8. The C engine computes the summary.
9. The callback returns JSON to WebView.
10. The frontend renders the summary or an error.

## Extension rule

For a new correctness-critical capability:

1. Add the domain API and tests to the C core.
2. Add only the required Lua binding operations.
3. Add only the required WebView bridge operation.
4. Update the frontend and bridge documentation.
5. Test each boundary independently.

Do not move engine state into Lua tables or frontend JavaScript merely to avoid
adding a native contract.
