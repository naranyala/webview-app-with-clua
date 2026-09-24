# WebView bridge protocol

The desktop frontend communicates with native code through the WebView binding
named `summarize`.

## JavaScript API

```js
const summary = await window.summarize([12.5, 15, 8.5, 14]);
```

The frontend converts its text input into an array of finite JavaScript
numbers before calling the bridge. It normally calls `window.summarize`; for
older WebKit runtimes where the convenience property is not installed, it can
use the equivalent internal `window.__webview__.call('summarize', values)`
path.

## Bridge detection

The frontend detects the bridge using this priority:

1. `window.summarize` - Direct binding from webview library (preferred)
2. `window.__webview__.call('summarize', values)` - Alternative binding

If neither is available, the UI displays an error indicating the desktop app
is required for calculations.

## Native request shape

The WebView library serializes the call as an argument list. For one argument,
the C callback receives:

```text
[[12.5, 15, 8.5, 14]]
```

The parser accepts optional surrounding whitespace, decimal and exponent
notation, signed values, and one inner array of one or more finite numbers.
It rejects empty arrays, malformed nesting, trailing data, non-numeric values,
non-finite values, and numeric overflow.

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

- **Empty input**: "Enter one or more finite numbers separated by commas."
- **Empty tokens**: "Found N empty tokens. Each comma should separate two numbers."
- **Invalid numbers**: "Invalid number(s): [list of first 3 invalid values]"
- **Bridge unavailable**: "The native WebView bridge is unavailable. Run the desktop app to calculate metrics."

## Testing the contract

Run the parser tests without opening a WebView window:

```sh
make bridge-test
```
