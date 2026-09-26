# Native Workspace Vue frontend

Vue 3 implementation of the local text metrics editor and PDF reader used by the desktop app.

## Development

```bash
npm install
npm run dev
```

`npm run check` formats and checks the sources, `npm test` runs the Node unit/static contract tests, and `npm run build` creates the standalone `dist/index.html` consumed by the desktop executable.

The browser build uses a file input for PDFs. In the desktop build, opening, PDF rendering, metrics calculation, and background TOC extraction use the native WebView bridge. Extracted TOC persistence remains handled by the native backend.
