# Frontend guide

The desktop frontend lives in [`frontend-vue/`](../frontend-vue/). It is a Vue 3
application built with Rsbuild.

## Source layout

```text
frontend-vue/
├── src/index.js                 Vue root mounting
├── src/App.vue                  composition: wiring, watchers, persistence, template
├── src/boot-state.js            one-time boot snapshot of the workspace
├── src/native-bridge.js         getNativeBinding / runNativeCall
├── src/file-io.js               text file transfer primitives and name suggestions
├── src/smoke.js                 desktop smoke checks and the host verdict
├── src/workspace-persistence.js snapshot, write order, debounce, hydration
├── src/workspace-report.js      persistence report -> header sentence
├── src/editor-session.js        Text Editor buffer, caret, word count, notice
├── src/app-shell.js             active view and transition hooks
├── src/pdf-session.js           PDF load, render, paging, path history, heading panel
├── src/image-session.js         folder selection, grouping, lightbox
├── src/map-explorer.js          Web Mercator tiles, pan/zoom, and the pin
├── src/outline-pdf.js           workspace folder, combine action, generated file
├── src/toc-outline.js           outline items and cross-tool links
├── src/workspace.js             persistent workspace store and outline schema
├── src/index.css                workspace layout and visual styling
├── public/index.html            Rsbuild HTML template
├── rsbuild.config.js            Vue and single-file setup
├── plugins/single-file-html.js  removes non-HTML build artifacts
└── tests/                       pure utility and static contract tests
```

## Session modules

`App.vue` is the composition layer: it imports the session modules, owns the
watchers, the lifecycle hooks, and the persistence loop, and renders the
template. Everything else lives in one module per concern:

| Module | Owns |
| --- | --- |
| `boot-state.js` | the single synchronous `loadWorkspace()` read per launch |
| `native-bridge.js` | resolving and running a host binding (`getNativeBinding`, `runNativeCall`), forwarding arguments on both host paths |
| `workspace-report.js` | turning a `getWorkspaceReport()` record into the header sentence |
| `file-io.js` | system-picker-first transfers (`readTextFileNative`, `writeTextFile`), browser fallbacks, `suggestFileName`, and `withFileTransfer` — the one place the success/cancel/error outcomes are handled |
| `smoke.js` | the `METRICS_SMOKE` checks, their single-line report, and the `smokeVerdict` call; inert without the host marker |
| `workspace-persistence.js` | the persistence engine: snapshot, `apply`, `persist`, `flush`, `schedule`, `hydrate`, and the mode — every dependency injected |
| `editor-session.js` | `editorContent`, the caret readout, the word counter, and the transfer notice |
| `app-shell.js` | `view`, `selectView()`, and the transition hooks `onViewLeaveEditor` / `onViewEnterPdf` |
| `pdf-session.js` | document loading, the canvas registry, paging, the remembered-path list, and the heading panel |
| `image-session.js` | folder pick, grouping, thumbnails, and the lightbox |
| `map-explorer.js` | the Web Mercator projection, the visible tile grid, pan/zoom, the pin, and `normalizeLocation()` — the one validator a stored place goes through |
| `toc-outline.js` | outline items, linking to pages, images, and places, draft sync, and JSON/text import/export |
| `outline-pdf.js` | the one workspace folder, `renderOutlinePdf`, and the generated file's identity — the host owns the folder, so the webview never names a path to write into |

Dependencies point one way: the modules import `workspace.js` and
`native-bridge.js`, and `App.vue` imports the modules. A module that needs
persistence or a cross-tool action receives it as an injection
(`configureTocOutline({ persistNow })`) or a registered hook, so no module has
to import `App.vue` back.

Biome does not model Vue template scope, so `noUnusedImports` is disabled for
`*.vue` files in `biome.json` (the same reason `noUnusedVariables` is off).
`tests/template-bindings.test.js` covers the other direction: it compiles the
template with Vue's own compiler and asserts that every `_ctx.name` reference
resolves to a script-setup binding.

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

`App.vue` composes the session modules into the welcome menu, writing editor,
TOC Manager, PDF Reader, PDF metadata, and extracted table of contents. The
module owns the cross-tool labels (`documentTitle`, `documentStatus`, the four
menu badges) because each one spans two sessions; every watcher that reacts to
a change also lives here. Selecting a card changes the active view without
navigating the WebView.

The Text Editor is a plain writing surface:

1. Opens only for a picked outline section: with no resolvable active item it
   shows a section picker (`.toc-pick`) instead of the textarea — pick a
   declared section to load its draft, or jump to the TOC Manager to declare
   the first one.
2. Keeps the cursor position and word count reactive.
3. Stores its buffer in `editorContent`, not in the metrics pipeline.
4. Autosaves the buffer into the bound outline item on every input event.
5. Shows the heading level, item position, and save state in the chrome.
6. Moves between outline items with `‹ Prev` / `Next ›` and returns to the
   outline with `Outline`.
7. Imports and exports the active draft: `Export…` writes it through the
   system save dialog (browser fallback: anchor download), `Import…` reads a
   text file (system open dialog, fallback: hidden input) and replaces the
   draft, flushing it into the outline item; the footer shows the notice.
8. Runs no metrics: `Run metrics`, the result panel, history, export, the tool
   rail, and `Ctrl+Enter` were removed.

Both file-facing cards expose exactly one picker control: the toolbar button
appears once content exists, the empty state offers the same action as its
primary call to action, and only one of the two is ever visible. Every call
goes through the same helpers — `getNativeBinding(name)` resolves
`window.<binding>` or the `window.__webview__.call` fallback, and
`runNativeCall()` turns results and thrown errors into one `{ error | value }`
shape shared by `openPdf`, `openImageDirectory`, and `extractPdfToc`. Without a
native binding each card falls back to its own hidden `input[type="file"]`.

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

1. Declares outline items from an inline create bar (title plus level 1-3)
   without a native call; the whole manager is one card centered over the
   viewport.
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
5. Edits title and level inline per row (Save/Cancel, empty titles rejected,
   levels clamped) without losing the draft, links, id, or position; reorders
   rows with move up/down buttons; removes a row with an Undo action in the
   toolbar that stays valid until the next outline mutation.
6. Shows a title filter once eight or more items exist; while filtering, the
   reorder buttons are disabled so edits always act on the visible list.
7. Imports and exports the outline as a versioned JSON file
   (`{"format":"metrics-toc","version":1,"items":[…]}`): `Export…` saves the
   whole outline through the system save dialog, `Import…` reads one and
   appends its sections after the existing items with fresh ids — never
   replacing what is already declared. Malformed files report through the
   TOC status line.

## Workspace integration

The four cards read and write one persisted record instead of isolated state:

1. `src/workspace.js` defines the schema, normalizes every field on read and
   write, migrates the legacy outline key, debounces saves, and records every
   storage failure as a report (`getWorkspaceReport()`: scope, code, message)
   instead of only logging it. Each save stamps `savedAt` so the newer copy
   wins. `App.vue` renders the latest report as a dismissible
   `#workspace-report` pill in the launcher header, so a corrupt stored copy,
   a rejected native read, or a failed write is visible in every view rather
   than hidden in the console.
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
   (`outlineBadge`, `editorBadge`, `pdfBadge`, `imagesBadge`, `mapBadge`).
5. The PDF sidepanel links the current page to an outline item
   (`attachPdfPageToToc`), imports extracted headings as items
   (`importPdfHeadingsToToc`), and the outline row and editor top bar jump back
   to that page (`openLinkedPdfPage`).
6. The image lightbox attaches the previewed image to a section
   (`attachImageToToc`); the outline row shows an `IMG n` badge and
   `openLinkedImages` resolves it, or reports the folder as not loaded.
7. The PDF reader and the Image Viewer never restore content on boot. Each
   remembers the paths it has opened (`recentPaths`, newest first, capped at
   `MAX_RECENT_PATHS`) and shows them in its empty state; picking an entry calls
   `openPdfAt` / `openImageDirectoryAt`, which open that absolute path with no
   chooser. A path the host can no longer open is dropped from the list, so the
   history heals itself. The editor's "jump to page" link follows the same rule:
   with nothing open it re-opens the document the link came from.
8. The Map Explorer links its pin to an outline item (`attachLocationToToc`);
   the outline row shows a `LOC` badge and `openLinkedLocation` re-centres the
   map on the saved place. Unlike an image link, a location link is
   self-contained, so it resolves on any later launch with no folder to
   re-select.

## OpenStreetMap Explorer

The fifth tool is a dependency-free tiled map. It adds no runtime package: the
projection is the standard Web Mercator formula, and the tiles are ordinary
`<img>` elements positioned by `visibleTiles()`.

1. `projectToPixel` / `unprojectFromPixel` convert between coordinates and
   global pixels, and `lonToTileX` / `latToTileY` give the fractional tile
   index. The tests pin these against known slippy-map tile numbers (San
   Francisco at z12 is 655/1583) rather than against the implementation.
2. `visibleTiles()` returns the tiles covering the viewport, each already
   offset in CSS pixels from its top-left corner, so the projection does the
   scrolling and the DOM only positions absolute images.
3. Dragging pans by unprojecting the pixel delta; the wheel zooms toward the
   cursor. `zoomMap` unprojects the anchor at the old zoom, reprojects it at the
   new one, and solves backwards for the centre — without the half-viewport term
   the anchor drifts by half a screen per zoom step.
4. A press and release within `CLICK_SLOP_PX` of each other drops the pin;
   anything further is a pan. The threshold is measured from where the press
   started, not from the last move, so a drag made of many small steps is still
   a drag.
5. The pane is `v-show`n, so it has no measurable size until the view is first
   entered. App.vue starts the `ResizeObserver` and measures on entry; with no
   size the tile list is empty and the pane says so rather than showing a blank
   grid.
6. There is no place search. Nominatim would need a second network dependency
   and an identifying User-Agent the embedded WebView cannot send, and
   Nominatim's usage policy is not satisfied by a bundled desktop app. Picking a
   point needs nothing but the tiles.

Tiles come from `openstreetmap.org` and the attribution is rendered
permanently, not faded. A build distributed to many machines should point
`tileUrl` at its own tile server; the public server's usage policy asks for an
identifying User-Agent and forbids bulk downloading.

## Combining the outline into one PDF

The TOC Manager toolbar has two new controls. **Workspace folder…** asks the host
for the single directory the combined file lives in; the host remembers the
choice, so the webview cannot name a write target itself. **Combine to PDF**
sends the outline to the host, which renders it and answers with the written
file's path, page count, and size. A **Preview** button then opens that file in
the existing PDF reader with `openPdfAt`.

The payload is `exportTocJson()` — the same versioned envelope the Export button
writes — so an export and a combined PDF can never disagree about what the
outline contains. Nothing is held in memory between the two steps: the PDF is a
file, and the preview opens it by path like any other document.

The folder is stored in the workspace schema as `pdf.workspaceDirectory`, but
only for display. The host owns the real path and re-asks after a fresh process,
so a stale stored value can mislead without ever causing a write somewhere the
user did not choose.

## Bridge integration

The frontend checks these native bindings in order:

1. `window.openPdf` for system PDF selection.
2. `window.openPdfAt` to open a remembered path without a chooser.
3. `window.openImageDirectory` for system directory selection.
4. `window.openImageDirectoryAt` to re-scan a remembered directory.
5. `window.extractPdfToc` for headings and cached TOC data.
6. `window.__webview__.call` as a compatibility fallback.

The native `summarize` binding is still registered by the C host and covered by
`make bridge-test`, but the current UI no longer calls it.

## Changing the frontend

When changing UI behavior or bridge contracts:

1. Update the owning session module, `App.vue` when the wiring changes, and
   `index.css`.
2. Update `workspace.js` if the persisted schema changes.
3. Update [the bridge protocol](bridge-protocol.md) when native contracts change.
4. Update Vue tests and static source contracts.
5. Run `npm run check`, `npm test`, and `npm run build`.
6. Run the desktop application for an end-to-end check.
