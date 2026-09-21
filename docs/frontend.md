# Frontend guide

The desktop frontend lives in [`frontend-octane/`](../frontend-octane/). It is
an Octane application built by Rsbuild.

## Source layout

```text
frontend-octane/
├── src/index.js                 Octane root mounting
├── src/App.tsrx                 metrics UI and bridge interaction
├── src/App.css                  layout and visual styling
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

The static HTML shell in `public/index.html` owns the initial visible layout.
This is intentional: WebView receives the form elements even if JavaScript
mounting is delayed or unavailable. `src/index.js` performs behavior work:

1. Split the textarea by commas.
2. Trim each token and reject blank/non-finite values.
3. Show a loading state.
4. Call `window.summarize(values)`.
5. Render the returned metrics or a readable error.

It does not duplicate the native statistics implementation.

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
2. Update [the bridge protocol](bridge-protocol.md).
3. Update bridge and frontend tests.
4. Run `npm run check` and `npm run build`.
5. Run the desktop application for a manual end-to-end check.
