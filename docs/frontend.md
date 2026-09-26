# Frontend guide

The desktop frontend lives in [`frontend-vue/`](../frontend-vue/). It is a Vue 3
application built with Rsbuild. The former Octane implementation remains in
`frontend-octane/` for reference but is not loaded by the desktop target.

## Source layout

```text
frontend-vue/
├── src/index.js                 Vue root mounting
├── src/App.vue                  workspace, writing editor, PDF, TOC, bridge
├── src/workspace.js             persistent workspace store and outline schema
├── src/index.css                workspace layout and visual styling
├── src/metrics-ui.js            reserved metrics parsing and bridge errors
├── public/index.html            Rsbuild HTML template
├── rsbuild.config.js            Vue and single-file setup
├── plugins/single-file-html.js  removes non-HTML build artifacts
└── tests/                       pure utility and static contract tests
```

## Build behavior

Rsbuild compiles the Vue single-file component, inlines scripts and styles,
uses one all-in-one chunk, and removes every emitted artifact except
`dist/index.html`.

```sh
cd frontend-vue
npm install
npm run check
npm test
npm run build
```

The desktop CMake target runs `npm run build` automatically and loads the
resulting `frontend-vue/dist/index.html`.

## UI behavior

`App.vue` uses Vue refs and computed state for the welcome menu, writing
editor, TOC Manager, PDF Reader, PDF metadata, and extracted table of contents.
Selecting a card changes the active view without navigating the WebView.

The Text Editor is a plain writing surface:

1. Keeps the cursor position and word count reactive.
2. Stores its buffer in `editorContent`, not in the metrics pipeline.
3. Autosaves the buffer into the bound outline item on every input event.
4. Shows the heading level, item position, and save state in the chrome.
5. Moves between outline items with `‹ Prev` / `Next ›` and returns to the
   outline with `Outline`.
6. Runs no metrics: `Run metrics`, the result panel, history, export, the tool
   rail, and `Ctrl+Enter` were removed.

The PDF reader:

1. Calls the native `openPdf` GTK picker when available.
2. Falls back to a browser file input and object URL outside the desktop host.
3. Renders the selected PDF with Mozilla PDF.js to a canvas instead of relying
   on WebKit's native PDF plugin.
4. Calls `extractPdfToc` and displays hierarchical headings in the sidepanel.
5. Navigates to heading pages and provides page navigation and zoom controls.
6. Lets the native backend reuse its persistent per-file TOC cache.

The TOC Manager is the fourth menu card and acts as the first step of the
writing flow:

1. Declares outline items locally (title plus level 1-3) without a native call.
2. Persists items and their drafts through the shared workspace store
   (`src/workspace.js`): the native `saveWorkspace` binding writes
   `native-workspace/workspace.json`, `localStorage`
   (`native-workspace.workspace.v1`) stays a synchronous boot cache, and the
   legacy `native-workspace.toc-items.v1` outline is migrated on first load.
3. Selecting an item binds the Text Editor to it: the document title becomes
   the heading, the saved draft is restored, and each input event writes the
   buffer back to that item.
4. Leaving the editor flushes the bound draft, so the outline always shows the
   latest word count and draft state.

## Workspace integration

The four cards read and write one persisted record instead of isolated state:

1. `src/workspace.js` defines the schema, normalizes every field on read and
   write, migrates the legacy outline key, debounces saves, and reports
   storage failures instead of throwing. Each save stamps `savedAt` so the
   newer copy wins.
2. `App.vue` seeds its refs from the synchronous `loadWorkspace()` cache and
   funnels every change (view, outline, bound item, editor buffer, PDF
   session, image folder) through a single `workspaceState()` snapshot saved
   by `scheduleWorkspaceSave()`, plus a flush on `pagehide`, `beforeunload`,
   `visibilitychange`, and unmount.
3. On mount it then adopts the file-backed copy written by the native host
   (`loadWorkspaceNative`) unless the user already interacted, and writes back
   through `saveWorkspaceNative` — serialized, one write at a time, skipping
   identical payloads. The editor footer reports where state went: `saved to
   disk`, `auto-saved`, or `not saved`.
4. The menu cards replace their static subtitles with live badges
   (`outlineBadge`, `editorBadge`, `pdfBadge`, `imagesBadge`).
5. The PDF sidepanel links the current page to an outline item
   (`attachPdfPageToToc`), imports extracted headings as items
   (`importPdfHeadingsToToc`), and the outline row and editor top bar jump back
   to that page (`openLinkedPdfPage`).
6. The image lightbox attaches the previewed image to a section
   (`attachImageToToc`); the outline row shows an `IMG n` badge and
   `openLinkedImages` resolves it, or reports the folder as not loaded.
7. The last PDF (name, size, `file://` source, document id, page, zoom) and the
   last image folder are restored on boot. `resumePdfSession()` re-renders the
   saved page when the source is still reachable, otherwise the reader shows a
   `Resume session` prompt with the saved position.

## Bridge integration

The frontend checks these native bindings in order:

1. `window.openPdf` for system PDF selection.
2. `window.extractPdfToc` for headings and cached TOC data.
3. `window.__webview__.call` as a compatibility fallback.

The native `summarize` binding is still registered by the C host and covered by
`make bridge-test`, but the current UI no longer calls it. `src/metrics-ui.js`
is kept with its tests so the metrics input path can be reintroduced later.

## Changing the frontend

When changing UI behavior or bridge contracts:

1. Update `App.vue` and `index.css`.
2. Update `metrics-ui.js` if the reserved metrics helpers change, or
   `workspace.js` if the persisted schema changes.
3. Update [the bridge protocol](bridge-protocol.md) when native contracts change.
4. Update Vue tests and static source contracts.
5. Run `npm run check`, `npm test`, and `npm run build`.
6. Run the desktop application for an end-to-end check.
