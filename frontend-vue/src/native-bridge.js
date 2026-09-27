/*
 * Thin layer over the desktop host's JavaScript bindings.
 *
 * A binding may exist as a plain global (window.openPdf) or behind the
 * WebView bridge (window.__webview__.call). Both shapes are normalized here so
 * every caller writes the same "get the binding, then run it" sequence and
 * falls back to the browser file input when no host is present.
 */

/*
 * Returns a function for the binding, or null outside the host. Arguments
 * are forwarded verbatim on both paths, so parameterized bindings
 * (saveTextFile) and plain ones (openPdf) are called the same way.
 */
export function getNativeBinding(name) {
  const binding = window[name];
  if (typeof binding === 'function') return (...args) => binding(...args);
  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return (...args) => window.__webview__.call(name, ...args);
  }
  return null;
}

/*
 * Awaits a native call and normalizes its outcome to a plain object:
 * the host's payload on success, or { error: { message } } when the call threw
 * or answered with a non-object. Callers only ever branch on `result.error`.
 * A rejection shaped like the host's { error: { code, message } } keeps both
 * fields, so the code survives into the caller's status line.
 */
export async function runNativeCall(call) {
  try {
    const result = await call();
    return result && typeof result === 'object' ? result : {};
  } catch (error) {
    const source =
      error && typeof error === 'object' && error.error !== undefined
        ? error.error
        : error;
    const message =
      source && typeof source.message === 'string'
        ? source.message
        : error instanceof Error
          ? error.message
          : String(error);
    const code =
      source && typeof source.code === 'string' ? source.code : undefined;
    return { error: code === undefined ? { message } : { code, message } };
  }
}
