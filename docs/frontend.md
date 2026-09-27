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
├── src/map-explorer.js          the map session: view state and interaction
├── src/map-projection.js        Web Mercator projection, tile grid, layer transform
├── src/map-input.js             what a wheel, drag, or key means
├── src/map-canvas.js            the canvas tile renderer
├── src/map-places.js            the persisted named-place collection
├── src/geo.js                   coordinate primitives shared by map and schema
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
| `map-explorer.js` | the session only: the view state, tile loading and zoom commits, pan/zoom and inertia, the pointer, wheel, and keyboard handlers, the view options, and the viewport measurement |
| `map-projection.js` | the pure geometry - `projectToPixel` / `unprojectFromPixel`, `visibleTiles`, `layerTransform`, `scaleBarFor`, `minimumZoomFor` - plus the tile and zoom constants. No state and no DOM, so the formulas are tested against known slippy-map tile numbers rather than through a session |
| `map-input.js` | the gesture vocabulary: `classifyWheel`, the click-versus-drag threshold, the flick physics, and the key pan step. Pure functions, so a wheel's intent is testable without a map |
| `map-canvas.js` | the canvas renderer: the decoded-bitmap cache, the frame coalescing, and the draw. Built from an accessor bundle rather than a session, so it is testable with a plain object and a stub image |
| `map-places.js` | the saved-place collection: add, rename, remove, clear, and the inline-edit state — persisted through the workspace schema |
| `geo.js` | `clampLatitude`, `wrapLongitude`, and `normalizeLocation()`. These live apart from the map so the schema can validate a stored coordinate without importing it; the import would otherwise close a cycle and leave the map's default arguments reading an uninitialised binding |
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
`<img>` elements.

### How it is drawn

Tiles never move in the DOM. Each sits at its absolute world-pixel position
inside one layer, and the layer carries a single `translate3d(...) scale(...)`.
Panning and zooming therefore write exactly one property that the compositor
handles, instead of invalidating the layout of every tile on every frame — which
is what made the first version stutter. `layerTransform()` is the whole map in one
expression; a test places a real tile set through it and asserts the viewport has
no gaps, at fractional zoom as well as whole.

Zoom is a float, but tile servers serve whole levels, so the drawn set is
committed at an integer `tileZoom` and the layer is scaled by
`2^(zoom - tileZoom)` while a gesture runs. Pinching scales the tiles already on
screen instead of blanking the map and fetching a new set dozens of times. The
new set is committed when the gesture settles or drifts past
`ZOOM_COMMIT_THRESHOLD`, at which point the scale is 1 again.

One ring of tiles beyond the viewport is always requested (`TILE_BUFFER`), so
panning almost never exposes a tile that was never fetched. The tile set is
floored, so it only changes when the viewport actually crosses a tile line — a
few pixels of drag do not churn the DOM.

### How it is driven

| Gesture | Result |
| --- | --- |
| Two-finger trackpad scroll | pans the map |
| Trackpad pinch, or a mouse notch | zooms about the cursor, in fractions |
| Drag | pans, with inertia on release |
| Double click | zooms in about the click |
| Arrows | pan; `shift` is a long step |
| `+` / `-` | zoom about the centre |

`classifyWheel()` decides the wheel's intent from its shape alone: `ctrl` (how a
browser reports a pinch) zooms, a large pixel delta or a line-mode delta is a
mouse notch and zooms, and anything small and pixel-valued is a trackpad scroll
and pans. Zooming on the small deltas is what previously made panning feel
impossible.

### Saved places

A place is a name plus a coordinate, and the two are inseparable: a record with
no label is rejected, because a list of bare `51.507351, -0.127758` lines is not
something anyone can scan. They are persisted in the workspace as `map.places`,
capped at `MAX_SAVED_PLACES` (200), newest first.

A place is separate from the outline's `links.location` on purpose. A place is
somewhere you have been; a location link is somewhere a section is *about*. They
meet at `attachPlaceToToc()`, which copies one into the other and reuses the
existing link machinery - the `LOC` badge, the status line, and the schema
validation all work unchanged.

The list rules exist to keep the collection usable: re-picking a place that is
already stored moves it to the top instead of creating a near-duplicate, a
duplicate id in a stored list is dropped (it would make every rename hit two
rows), and the cap is enforced on read as well as on write.

Places appear in three places at once - as a row in the sidebar, as a labelled
marker on the map, and as the thing the `Link` button attaches - and all three
read the same collection.

### Persisting them, and how that silently fails

The list is part of the workspace document (`map.places`), so it is written by
the same `saveWorkspace` path as everything else and needs no storage of its own.

The part that is easy to get wrong is the *trigger*. The persistence engine has
no way to know anything changed: `App.vue` drives it entirely from a
`watch([...])` list. A ref that the snapshot reads but the watcher does not
include is persisted in principle and written in practice never - the value is
right in memory, the UI is right, and it is gone after a restart.

The whole Explorer's state, saved places included, was missing from that list.
The one visible symptom was a "Save pin" button that appeared to work, because
`promptSavePlace` had a hand-written save call - while renaming, removing,
clearing, and every view option silently did nothing. `workspaceDirectory`, the
folder the combined-outline PDF is written to, had the same defect.

`tests/workspace-persistence.test.js` now checks the two lists against each
other: it derives the persisted refs from `snapshot()` and the watched refs from
`App.vue`, and fails if anything in the first is missing from the second. It
handles all three access shapes the snapshot uses (a plain ref, an optional ref,
and a getter, which is how the place collection is passed because it is replaced
wholesale rather than mutated in place) and states the one name that differs
rather than guessing at it. That check found the second, identical bug
immediately.

### Rendering options

| Option | What it does |
| --- | --- |
| Colour filter | grayscale, dark, sepia, vivid, faded, or original. Applied to the tile layer or canvas as one CSS `filter`, so the browser filters a single element instead of compositing each tile |
| Renderer | `DOM` draws a few dozen `<img>` tiles; `Canvas` draws the same set through the same `layerTransform()` onto one element |
| Tile grid | A background locked to tile lines. The cell size carries the layer scale and the offset the layer translate, so the grid tracks the map exactly instead of drifting a pixel per pan |
| Cursor readout | The coordinate under the pointer, updated on every move and cleared when it leaves or is switched off |
| Sidebar | Collapsed by narrowing the column, not by unmounting, so the list keeps its scroll position and the canvas keeps a measured width |

`MAP_FILTERS` is a closed list on both sides: each name has a matching
`.map-canvas.filter-<name>` rule, and an unrecognised value - from a newer build,
say - falls back to `none` rather than producing a class with no rules and a map
with no way back.

### How the map is split

Six modules, layered so each one only depends on the ones above it:

```
geo.js            coordinate primitives; imports nothing
map-projection.js geometry and layout;        -> geo
map-input.js      gesture vocabulary;          imports nothing
map-canvas.js     the canvas renderer;         imports nothing
map-explorer.js   the session that composes them
map-places.js     the saved-place collection
```

`geo.js` and `map-input.js` and `map-canvas.js` are leaves, which is what keeps
the graph acyclic. That matters: an earlier version had the schema importing the
map to get a coordinate validator, which closed
`map -> boot-state -> workspace -> map` and left the map's default arguments
reading an uninitialised binding. The rule that falls out of it is that a pure
function is imported from wherever it is defined, never injected through a
session - so `toc-outline.js` takes `normalizeLocation` from `geo.js` rather than
from the map it is handed.

**Why the canvas renderer is an option and not the default.** It removes every
tile from the layout tree, which is what a slow pan pays for, but it needs its
images decoded and drawn by hand and repainted on a frame. The DOM version lets
the browser do that work. The canvas keeps a cache of decoded bitmaps keyed by
tile, so panning back over ground already walked re-uses a bitmap rather than
re-fetching, and drops the ones that leave the buffered set to bound the memory.
The two differ in one visible way: only the DOM path can cross-fade the outgoing
tile set, because the outgoing set belongs to the *previous* tile zoom and would
need the previous transform to be placed correctly.

### Travelling between places

Choosing a saved place - from the sidebar, a marker, or the outline's `LOC`
badge - **flies** the map there over ~560ms rather than teleporting. A jump loses
the sense of direction that makes a map usable as a mental model: you arrive
somewhere and have no idea which way you came from or how far.

* `interpolateView(from, to, t)` projects both positions at the *current*
  interpolated zoom and lerps there, rather than lerping latitude and longitude.
  A lat/lon lerp is not a straight line on screen, so a long flight bows away
  from the line it appears to take and the map seems to drift. Projecting at the
  current zoom also makes travel cover a constant number of pixels per second, so
  the flight neither crawls zoomed out nor bolts zoomed in.
* `easeInOutCubic` starts and ends gently. A linear ramp reads as a machine; an
  ease-in-only reads as a stall followed by a lurch, which is worse when the
  reader is trying to keep their bearings.
* The **tile set is re-committed during the journey**, using the same threshold
  a pinch uses. Committing only at the end would magnify the starting tiles by
  the whole zoom difference - sixteen times for a jump from zoom 10 to 14. The
  previous integer level stays underneath as a backdrop, so the ground under the
  journey is never blank.
* The outgoing layer stores the **tile zoom it was fetched at** and derives its
  transform live from the current view. A captured transform freezes those tiles
  where they were at the moment of the change, so they sit visibly misaligned -
  and during a flight, which animates the view, for the whole journey.
* The outgoing layer is retired only once **every** incoming tile has reported in.
  Retiring it on the first arrival drops the ground the map is standing on while
  most of the new tiles are still missing.
* The **pin lands with the map**, and only if the journey was not interrupted, so
  it cannot end up marking a place the reader never actually reached.
* Any deliberate input - a grab, a wheel, an arrow key, a double click - cancels
  the journey and the view stays where it is. A key the map does not use does
  not, so typing does not cancel it.
* `prefers-reduced-motion: reduce` skips the journey entirely and arrives
  directly; for a reader who finds motion uncomfortable the journey is the
  problem, not a nicety.

A place already framed at the level it is looked at from starts no journey, but
one that is on screen at the wrong scale is still zoomed in to - and that zoom is
animated too, since a sudden jump from zoom 4 to 13 is disorienting in the other
direction as well. A journey never zooms *out* to reach a nearby place: the
target is the closer of the reader's current zoom and 13, never the further.

### Staying inside the world

Longitude wraps, so the map repeats indefinitely. Latitude does not: the world
ends at the pole cut-off, so at high zoom a viewport centred near a pole extends
past the top or bottom of the world, where no tile rows exist. The centre is
pulled back inside, or centred outright when the world is shorter than the pane.

At the other end, a world map shrinks with zoom, so at low levels it can be
smaller than the window and there are simply no tiles for the rest. Rather than
show that void, `minimumZoomFor()` raises the zoom floor until the world covers
the viewport. The two together mean there is no zoom, pan, or window size at
which the pane shows bare background.

Also present: a scale bar in metric and imperial derived from the resolution at
the current centre, a zoom readout that shows a decimal only between levels, a
loading indicator, and the outgoing tile set held underneath the incoming one so
a zoom commit fades rather than flashing.

Tiles come from `openstreetmap.org` and the attribution is rendered
permanently, not faded. A build distributed to many machines should point
`tileUrl` at its own tile server; the public server's usage policy asks for an
identifying User-Agent and forbids bulk downloading, and every extra prefetch
ring multiplies the requests it sees.

There is no place search. Nominatim would need a second network dependency and
an identifying User-Agent the embedded WebView cannot send, and Nominatim's usage
policy is not satisfied by a bundled desktop app. Picking a point needs nothing
but the tiles.

Cairo's text shaping does not apply here, but the same limitation does apply to
the outline PDF renderer: see the combined-PDF section for the text caveats.

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
