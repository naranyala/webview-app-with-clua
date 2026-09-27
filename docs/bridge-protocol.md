# WebView bridge protocol

The desktop frontend communicates with native code through the WebView binding
named `summarize`.

## JavaScript API

```js
const summary = await window.summarize([12.5, 15, 8.5, 14]);
```

The frontend converts its text input into an array of finite JavaScript
numbers before calling the bridge. Numbers can be separated by commas or
newlines. It normally calls `window.summarize`; for older WebKit runtimes
where the convenience property is not installed, it can use the equivalent
internal `window.__webview__.call('summarize', values)` path.

## Bridge detection

The frontend detects the bridge using this priority:

1. `window.summarize` - Direct binding from webview library (preferred)
2. `window.__webview__.call('summarize', values)` - Alternative binding

If neither is available, the UI displays an error indicating the desktop app
is required for calculations.

## PDF picker

The PDF reader also calls the native `openPdf` binding:

```js
const document = await window.openPdf();
```

On the main GTK thread, the native callback opens a system file chooser limited
to PDF files. Both desktop pickers share one implementation in
`src/app_support.c`: `run_path_chooser` builds the GTK dialog from a kind
(`PICKER_OPEN_FILE` / `PICKER_SELECT_FOLDER` / `PICKER_SAVE_FILE`, with an
optional file filter and suggested name) and `dispatch_picker` performs the
request bookkeeping for `openPdf`, `openImageDirectory`, and the text
transfers alike. The PDF-specific validation lives in
`src/pdf_session.c`: it verifies that the selection is a regular readable file with a
`%PDF-` header, then returns the display filename, byte size, a `documentId`, an
encoded `file://` URL, and a `dataUrl` for files up to 32 MiB. The data URL lets
PDF.js render native selections from an embedded WebView without relying on
WebKit's unavailable native PDF plugin. Larger files remain available through
the encoded URL. The full local path remains native-only. Cancellation returns
`{ "canceled": true }`; invalid files return a structured error.

The frontend persists the returned `documentId` and encoded `file://` URL
together with its own page and zoom position in the workspace store, so a
restart can re-render the same document without another picker round trip. If
the WebView refuses to fetch that URL, the reader falls back to an explicit
re-open prompt; a native `restorePdf` command remains a conditional follow-up
(see `TODOS.md`, TODO-032).

## Image directory picker

The image viewer calls the native `openImageDirectory` binding:

```js
const folder = await window.openImageDirectory();
```

It opens the same chooser in `PICKER_SELECT_FOLDER` mode, scans the folder for
images within the size and count limits, and answers
`{ "images": [...], "name": "...", "limited": false }` with base64 data URLs,
or `{ "canceled": true }`. Outside the desktop host the frontend uses its own
`input[webkitdirectory]` fallback instead.

## Text file transfer

The TOC Manager (outline JSON) and the Text Editor (draft text) move whole
files through two bindings implemented in `src/text_transfer.c`:

```js
const picked = await window.openTextFile();
const saved = await window.saveTextFile('outline.json', serialized);
```

`openTextFile` takes no arguments. It opens the system chooser in
`PICKER_OPEN_FILE` mode, reads the chosen file, and answers
`{ "name": "...", "path": "...", "content": "..." }`; cancellation returns
`{ "canceled": true }`.

`saveTextFile` receives the suggested file name and the full text as its two
string arguments. The argument list is validated before any dialog opens, the
suggested name is sanitized by `text_transfer_suggest_name()` (final path
segment only, reserved characters replaced, capped on a UTF-8 boundary), and
the chooser runs in `PICKER_SAVE_FILE` mode with GTK overwrite confirmation.
The write goes through `g_file_set_contents` (temp file plus rename) and
answers `{ "name": "...", "path": "...", "bytes": N }`.

Both directions cap payloads at 8 MiB (`TEXT_TRANSFER_MAX_BYTES`). Failures
use the shared error shape with the codes `INVALID_ARGUMENT` (malformed or
oversized `saveTextFile` payload), `FILE_TOO_LARGE`, `READ_FAILED`,
`WRITE_FAILED`, `DISPATCH_ERROR`, and `INTERNAL_ERROR`.

Outside the desktop host the frontend falls back to its own hidden
`input[type="file"]` for reads and an anchor download for writes; both live
in `src/file-io.js`, which normalizes every outcome to
`{ error | canceled | value }` for its callers.

## One codec, one error shape

Every JSON byte the host writes and every request string it reads goes through
one module, `src/json_io.c` (`include/json_io.h`): `json_append_string()` and
`json_append_error()` for output, and `json_read_string_array()` for input.
That last one is the single request grammar — full escapes including
`\uXXXX` surrogate pairs, a raw control byte **rejected** rather than copied,
and nothing after the closing bracket — and it allocates each decoded value at
exactly its decoded length. The bindings keep their own status vocabularies on
top of it, but they no longer each carry a parser, which is how `saveWorkspace`
and `saveTextFile` used to disagree about the same payload.

Only the glue that answers a pending request lives above the codec:
`return_native_error()` is the single way a binding fails, and
`picker_request_release()` the single way a dispatched picker is torn down.

## Smoke verdict

One binding exists only while the host runs as a smoke run
(`METRICS_SMOKE=1`, see `src/smoke.c`). It is what turns the GUI smoke test
into an exit code:

```js
const acknowledged = await window.smokeVerdict('1', 'checks=5/5');
```

The request is `["1"|"0", "report"]`, decoded strictly: no escape sequences, no
control characters, and nothing after the closing bracket, because the report
is machine generated by `src/smoke.js`. The host prints one
`SMOKE VERDICT pass=<0|1> report=<...>` line on stdout, records `0` or `1` as
the process exit code, and terminates the event loop. A malformed request
rejects with `INVALID_ARGUMENT` and the run continues, so a broken runner
still ends in a failure rather than a hung window. The binding is absent
without `METRICS_SMOKE`, and `window.__METRICS_SMOKE__` (plus
`__METRICS_SMOKE_WRITABLE__` when `XDG_DATA_HOME` is set explicitly) is
injected before the page scripts so the frontend knows to run the checks.

## PDF heading extraction

After `openPdf` succeeds, the frontend calls:

```js
const toc = await window.extractPdfToc();
```

The native background worker runs Poppler's `pdftotext` in TSV mode and groups
words into lines. Lines whose text height is larger than the document's median
body-text height, plus numbered chapter/section lines, become headings. Heading
depth and page position are included for navigation. A layout-text heuristic is
used when font-size TSV data does not produce candidates.

Results are cached under `$XDG_DATA_HOME/native-workspace/pdf-toc/`. The cache
entry is invalidated when the file size or modification time changes. The
response shape is:

```json
{
  "documentId": "sha256-fingerprint",
  "cached": false,
  "headings": [
    { "page": 1, "level": 1, "position": 16.65, "title": "Chapter One" }
  ]
}
```

## Workspace persistence

The whole workspace (active view, outline, drafts, PDF session, image
selection) is stored by the native host, because the default inline render
mode loads the page from `about:blank` where WebView storage never reaches
disk:

```js
const loaded = await window.loadWorkspace();
const saved = await window.saveWorkspace(JSON.stringify(workspace));
```

`loadWorkspace` takes no arguments and answers:

```json
{ "ok": true, "workspace": { "version": 1, "savedAt": 1700000000000 } }
```

`workspace` is the stored document itself (already JSON, so it is embedded
unescaped), or `null` when nothing has been written yet. Non-empty bytes that
are not a JSON object (a truncated or overwritten file) reject with
`INVALID_CONTENT` instead of silently answering `null`, so the frontend can
report the damaged copy rather than booting as if it were empty.

`saveWorkspace` receives the serialized workspace as its single string
argument and answers `{ "ok": true }`. Failures reject with the shared error
shape:

```json
{ "error": { "code": "PAYLOAD_TOO_LARGE", "message": "..." } }
```

Codes: `INVALID_ARGUMENT`, `INVALID_PAYLOAD`, `PAYLOAD_TOO_LARGE`,
`READ_FAILED`, `INVALID_CONTENT` (load only), `WRITE_FAILED`,
`INTERNAL_ERROR`.

Both commands use `$XDG_DATA_HOME/native-workspace/workspace.json`
(`g_get_user_data_dir()`), cap payloads at 4 MiB, and write atomically. The
frontend prefers this store and keeps `localStorage`
(`native-workspace.workspace.v1`) as a synchronous boot cache; whichever copy
carries the newer `savedAt` wins on startup.

## Native request shape

The WebView library serializes the call as an argument list. For one argument,
the C callback receives:

```text
[[12.5, 15, 8.5, 14]]
```

The parser accepts optional surrounding whitespace (including newlines),
decimal and exponent notation, signed values, and one inner array of one or
more finite numbers. It rejects empty arrays, malformed nesting, trailing
data, non-numeric values, non-finite values, and numeric overflow.

## Success response

The native callback returns:

```json
{
  "count": 4,
  "sum": 50,
  "min": 8.5,
  "max": 15,
  "mean": 12.5,
  "variance": 6.25
}
```

`variance` is population variance.

## Error response

Invalid input produces a structured error:

```json
{"error":{"code":"EMPTY_INPUT","message":"Send a non-empty array of finite numbers."}}
```

Possible error codes are `INVALID_REQUEST` for malformed input,
`EMPTY_INPUT` for an empty array, `INVALID_VALUE` for non-finite or
out-of-range numbers, and `OUT_OF_MEMORY` for native allocation failure.

The native callback also reports a failed WebView binding result. The frontend
handles this through its `try/catch` path and displays the returned message.

## Frontend error handling

The frontend provides detailed error messages for common issues:

- **Empty input**: "Enter one or more finite numbers separated by commas or newlines."
- **Empty tokens**: "Found N empty tokens. Each comma or newline should separate two numbers."
- **Invalid numbers**: "Invalid number(s): [list of first 3 invalid values]"
- **Bridge unavailable**: "The native WebView bridge is unavailable. Run the desktop app to calculate metrics."

## Testing the contract

Run the parser tests without opening a WebView window:

```sh
make bridge-test
```
