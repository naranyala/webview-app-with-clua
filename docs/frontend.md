# Frontend guide

The desktop frontend lives in [`frontend-octane/`](../frontend-octane/). It is
an Octane application built by Rsbuild.

## Source layout

```text
frontend-octane/
├── src/index.js                 Octane root mounting
├── src/App.tsrx                 editor UI, behavior, and bridge interaction
├── src/App.css                  editor layout and visual styling
├── src/metrics-ui.js            parsing, formatting, and summary rendering
├── src/global.d.ts              TypeScript type declarations
├── public/index.html            static HTML shell for WebView compatibility
├── rsbuild.config.js            Octane, Tailwind, and single-file setup
└── plugins/single-file-html.js  removes non-HTML build artifacts
```

## Build behavior

The Rsbuild configuration enables Octane compilation, Tailwind CSS processing,
inlined scripts and styles, one all-in-one output, and removal of every emitted
artifact except the HTML file.

Build it with:

```sh
cd frontend-octane
npm run build
```

The desktop CMake target runs this command automatically before compiling the
native host.

## UI behavior

The static HTML shell in `public/index.html` owns the initial visible editor
layout: a top toolbar, a plain text editing surface, a right-side vertical
toolbar, and an output panel. This is intentional: WebView receives the editor
even if JavaScript mounting is delayed or unavailable. When JavaScript is
available, `src/index.js` mounts `App.tsrx`, which owns the behavior:

1. Keep the text editor and cursor indicator responsive.
2. Split the editor text by commas.
3. Trim each token and reject blank/non-finite values.
4. Show a loading state.
5. Call `window.summarize(values)`.
6. Render the returned metrics or a readable error.
7. Track calculation history.
8. Allow exporting history as JSON.

It does not duplicate the native statistics implementation.

## Features

### Input Validation
- Real-time input validation with descriptive error messages
- Token counting and validation status display
- Support for integers, decimals, negative numbers, and scientific notation

### Calculation History
- All calculations are tracked in memory
- Export history as JSON file for analysis
- Timestamps for each calculation

### Keyboard Shortcuts
- `Ctrl+Enter` - Run metrics calculation

### UI Enhancements
- Responsive design for different screen sizes
- Better number formatting with comma separators
- Timestamp display for calculation results
- Help panel with usage instructions

## Bridge Integration

The frontend communicates with the native C engine through the WebView bridge.
The bridge detection logic checks for:

1. `window.summarize` - Direct binding from webview library
2. `window.__webview__.call` - Alternative binding for older WebKit runtimes

If neither is available, the UI shows an error message indicating that the
desktop app is required for calculations.

## Browser development

Use `npm run dev` for layout and interaction work. The dev server does not
provide the WebView native binding, so calculations cannot complete there. The
missing bridge is handled explicitly in the UI rather than hidden behind a
mock result.

For native integration checks, build and launch:

```sh
make desktop
```

## Changing the frontend

When changing the input grammar or result fields:

1. Update `App.tsrx`.
2. Update `metrics-ui.js` for parsing/formatting changes.
3. Update `global.d.ts` for TypeScript type declarations.
4. Update [the bridge protocol](bridge-protocol.md).
5. Update bridge and frontend tests.
6. Run `npm run check` and `npm run build`.
7. Run the desktop application for a manual end-to-end check.
