# Architecture and data flow

## The one rule

> **The UI owns input and presentation. C owns validation, state, and
> persistence.**

Almost every design decision in this repository follows from that sentence, so it
is worth being concrete about what it forbids:

- The page must not parse a host response. It gets structured JSON or nothing.
- The page must not reach the network for a capability the host owns.
- Engine state must not be mirrored into Lua tables or JavaScript objects, because
  a mirror is a second copy that will diverge.

There is **one known violation**, recorded rather than hidden: the Map Explorer
loads tiles from the page via `<img src>` instead of through a native binding.
TODO-035 and TODO-036.

## Component map

```text
                          programmatic path
      Lua script ──> lua/native/core.lua ──> native.metrics
                                                 │
                                                 ▼
                                       C metrics engine
                                                 ▲
                                                 │
      Vue UI (frontend-vue) ──> window bindings ──> WebView host
                             presentation path       │
                                                  ▼
                                         webview_bridge.c
                                                  │
                                                  ▼
                                       C metrics engine

      Vue UI ──> loadWorkspace / saveWorkspace ──> workspace_store.c
                                                    │
                                                    ▼
                            $XDG_DATA_HOME/native-workspace/workspace.json
```

The two consumers share the engine implementation and **share no UI or workflow
code**. `lua/examples/ui.lua` exists to keep the Lua presentation surface visible
and honest; nothing loads it.

## Ownership

### The C core

[`src/metrics.c`](../src/metrics.c) owns an opaque `metrics_engine` holding count,
sum, running mean, running second moment, minimum, and maximum. The public API is
five functions in [`include/metrics.h`](../include/metrics.h).

Two properties matter more than the arithmetic:

- **A rejected value does not change engine state.** Every update is computed into
  locals and committed only after all the checks pass, so an overflow or a
  non-finite input leaves the engine exactly as it was.
- **The mean is never derived from the sum at read time.** Welford's recurrence
  keeps a running mean and second moment, so `mean` and `variance` stay correct
  for values whose naive sum would lose precision — which is the ordinary case,
  not an exotic one.

### The Lua binding

[`src/lua_metrics.c`](../src/lua_metrics.c) wraps the C pointer in userdata. Lua
owns the handle reference and `__gc` releases the engine;
[`lua/native/core.lua`](../lua/native/core.lua) adds `metrics.from(values)` on top.

### The desktop host

Split by concern so no translation unit owns more than one responsibility:

| File | Responsibility |
| --- | --- |
| [`src/webview_app.c`](../src/webview_app.c) | Entry point: creates the WebView, registers the bindings, chooses the render mode |
| [`src/webview_bridge.c`](../src/webview_bridge.c) | The `summarize` request parser, with no WebView dependency, so it is testable alone |
| [`src/json_io.c`](../src/json_io.c) | The single JSON writer and binding-request reader. No webview, no GTK |
| [`src/app_support.c`](../src/app_support.c) | Shared plumbing: error replies, `file://` URLs, picker dispatch, the GTK path chooser |
| [`src/workspace_store.c`](../src/workspace_store.c) | The durable file: atomic write, size cap, request decoding |
| [`src/workspace_bindings.c`](../src/workspace_bindings.c) | `loadWorkspace` / `saveWorkspace` |
| [`src/pdf_toc.c`](../src/pdf_toc.c) | PDF heading extraction, per-document cache, serialization |
| [`src/pdf_session.c`](../src/pdf_session.c) | `openPdf`, `openPdfAt`, `extractPdfToc`, and the extraction thread |
| [`src/image_directory.c`](../src/image_directory.c) | `openImageDirectory`, `openImageDirectoryAt`, `loadImageAt`, and the bounded scan |
| [`src/outline_pdf.c`](../src/outline_pdf.c) | `chooseOutlineDirectory` / `renderOutlinePdf` and the combine |
| [`src/text_transfer.c`](../src/text_transfer.c) | `openTextFile` / `saveTextFile` |
| [`src/smoke.c`](../src/smoke.c) | `smokeVerdict`, registered **only** under `METRICS_SMOKE=1` |

That is 14 bindings. `tests/bridge-bindings.test.js` checks the list against
`docs/bridge-protocol.md` in both directions, so a binding added here cannot ship
undocumented.

The host does **not** embed Lua. The CMake desktop target links the metrics core
and the bridge parser directly.

### The workspace store

[`src/workspace_store.c`](../src/workspace_store.c) owns durable frontend state.
It reads and writes `g_get_user_data_dir()/native-workspace/workspace.json` by
writing a temporary file, `fsync`ing it, renaming atomically, and `fsync`ing the
directory so a completed rename survives a crash. It enforces a 4 MiB payload cap
in both directions.

This is the second native surface, and it is a small tested contract rather than
an implementation detail. WebView storage is only a synchronous boot cache,
because the inline render mode never persists it — so the file is the durable
copy, and reconciliation is one comparison: whichever `savedAt` is newer wins.

### The frontend

[`frontend-vue/src/App.vue`](../frontend-vue/src/App.vue) is the composition root.
It builds the session wiring, the persistence engine, and the lifecycle hooks, and
renders the shell chrome and the menu. **It does not hold the panes' markup** —
that is six components in `src/components/`, each importing the session modules it
reads rather than taking state through props.

```
App.vue ──> session modules (toc-outline, pdf-session, image-session, map-*, …)
   │              │
   │              └──> workspace.js  (the only owner of the persisted shape)
   │
   └──> workspace-persistence.js  (snapshot, debounce, write order, restore)

components/*Pane.vue ──> session modules, directly
components/MapPane.vue ──> map-explorer.js ──> map-viewport.js ──> map-canvas.js
```

The pane components' root element is the `<section>` that used to carry
`v-show="view === '…'"` in `App.vue`, so switching views still leaves every pane
mounted — which is what lets the WebKit repaint watcher and the smoke run find
their anchors on a fresh boot.

Full detail, including the module dependency graph and why it is acyclic, is in
[the frontend guide](frontend.md).

## Runtime sequence

1. CMake runs the frontend build, producing one self-contained `index.html` with
   its assets inlined and a Content-Security-Policy injected.
2. The host reads that file into memory and registers the bindings.
3. The frontend calls `loadWorkspace` and adopts the result, or the boot cache if
   the file is absent.
4. Vue renders the menu, or the restored view.
5. The user declares a section, opens a PDF, picks an image folder, or drops a
   pin; the frontend calls the matching binding.
6. WebView serializes the request and invokes the C callback.
7. The owning module parses and validates it — `webview_bridge.c` for `summarize`,
   otherwise the module that owns that binding.
8. C does the work: heading extraction, a bounded directory scan, an atomic
   workspace write, a summary.
9. The callback returns JSON to WebView.
10. The frontend renders the result, or a specific error through the pane's status
    line.

Every binding fails through one `return_native_error()` path, so the error
vocabulary is shared and a failure never escapes as an exception the UI has to
guess at. See [the bridge protocol](bridge-protocol.md).

## The extension rule

For a new correctness-critical capability:

1. Add the domain API and tests to the C core.
2. Add only the required Lua binding operations.
3. Add only the required WebView bridge operation.
4. Update the frontend and the bridge documentation.
5. Test each boundary independently.

Do not move engine state into Lua tables or frontend JavaScript merely to avoid
adding a native contract.
