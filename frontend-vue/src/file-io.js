/*
 * File transfer primitives shared by the TOC Manager and the Text Editor.
 *
 * Every transfer prefers the desktop host's system picker (the openTextFile
 * and saveTextFile bindings) and falls back to browser primitives when the
 * host is absent: the caller's hidden input[type="file"] for reads, and an
 * anchor download for writes. Results are normalized so callers only branch
 * on `result.error` and `result.canceled`.
 *
 * withFileTransfer() is the one place that branching lives. It ran as six
 * copy-pasted ladders across the TOC Manager, the editor, and the Image
 * Viewer, each with its own "was cancelled" wording and its own status setter;
 * now a transfer reports through a single `report(message, isError)` callback
 * and the handler only sees the successful value.
 */

import { getNativeBinding, runNativeCall } from './native-bridge.js';

/* Characters that must never appear in a suggested file name. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|]/;

/*
 * Suggested export name: the title with unsafe characters replaced, capped
 * in UTF-8 bytes so the native sanitizer never has to re-cut it, and given
 * the target extension unless it already ends with it.
 */
export function suggestFileName(
  title,
  fallbackExt = 'txt',
  fallbackBase = 'document',
  maxBaseBytes = 50,
) {
  const extension =
    String(fallbackExt)
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase() || 'txt';
  let base = '';
  for (const point of String(title ?? '')) {
    const code = point.codePointAt(0) ?? 0;
    base +=
      code < 0x20 || code === 0x7f || UNSAFE_NAME_CHARS.test(point)
        ? ' '
        : point;
  }
  base = base.replace(/\s+/g, ' ').trim();
  if (base === '' || base === '.' || base === '..') {
    base = String(fallbackBase).trim() || 'document';
  }
  base = truncateUtf8(base, maxBaseBytes).replace(/[.\s]+$/, '');
  if (base === '') base = String(fallbackBase).trim() || 'document';
  if (!base.toLowerCase().endsWith(`.${extension}`)) base += `.${extension}`;
  return base;
}

/* Shortens text to at most maxBytes UTF-8 bytes on a code-point boundary. */
function truncateUtf8(text, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let result = '';
  let used = 0;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (used + size > maxBytes) break;
    result += point;
    used += size;
  }
  return result;
}

/*
 * Native open picker: resolves to {name, path, content}, {canceled: true},
 * or {error}, and to null when the host has no binding (the caller then
 * falls back to its own hidden input).
 */
export async function readTextFileNative() {
  const open = getNativeBinding('openTextFile');
  if (!open) return null;
  const picked = await runNativeCall(open);
  if (picked.error || picked.canceled) return picked;
  return {
    name: String(picked.name || ''),
    path: String(picked.path || ''),
    content: String(picked.content ?? ''),
  };
}

/*
 * Writes content to a file. With the host it opens the system save dialog
 * and answers {name, path, bytes}; outside the host it triggers a download
 * of the suggested name and answers {name, bytes}. Cancels and failures
 * surface as {canceled: true} / {error}.
 */
export async function writeTextFile(suggestedName, content) {
  const save = getNativeBinding('saveTextFile');
  if (save) {
    const saved = await runNativeCall(() =>
      save(String(suggestedName), String(content)),
    );
    if (saved.error || saved.canceled) return saved;
    return {
      name: String(saved.name || suggestedName),
      path: String(saved.path || ''),
      bytes: Number.isFinite(Number(saved.bytes)) ? Number(saved.bytes) : 0,
    };
  }
  return downloadTextFile(String(suggestedName), String(content));
}

/* Browser write fallback: an anchor download of a Blob. */
function downloadTextFile(name, content) {
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    globalThis.setTimeout?.(() => URL.revokeObjectURL(url), 1000);
    return { name, bytes: new TextEncoder().encode(content).length };
  } catch {
    return {
      error: {
        message: 'The download could not be started in this browser.',
      },
    };
  }
}

/*
 * Reads the chosen File from a hidden input's change event. A modern File
 * exposes text() directly, so FileReader is only the fallback for older hosts.
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file was chosen.'));
      return;
    }
    if (typeof file.text === 'function') {
      file.text().then(
        (value) => resolve(String(value ?? '')),
        (error) => reject(error ?? new Error('The file could not be read.')),
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error || new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}

/*
 * Runs one transfer and reports it through `report(message, isError)`.
 *
 * The three outcomes every transfer has — a failure, a user cancelling, and a
 * value — are handled once, with the wording supplied by the caller so each
 * tool still says something specific. `handle(value)` runs only on success and
 * may be async; whatever it returns comes back to the caller, so a transfer
 * that needs to keep working after an await can await the result.
 *
 * Returns `{ status, value, result }` where status is 'done', 'canceled',
 * 'error', or 'skipped', so a caller can react without parsing messages.
 */
export async function withFileTransfer(
  transfer,
  { report, messages = {}, handle = null } = {},
) {
  const say = typeof report === 'function' ? report : () => {};
  const failed = messages.error || 'The transfer failed.';
  const canceled = messages.canceled || 'The transfer was cancelled.';
  let result;

  if (messages.pending) say(messages.pending, false);
  try {
    result = await transfer();
  } catch (error) {
    say(error?.message || failed, true);
    return { status: 'error', value: null, result: null };
  }

  if (result === null || result === undefined) {
    say(messages.unavailable || failed, true);
    return { status: 'error', value: null, result: null };
  }
  if (result.error) {
    say(result.error.message || failed, true);
    return { status: 'error', value: null, result };
  }
  if (result.canceled) {
    say(canceled, false);
    return { status: 'canceled', value: null, result };
  }

  if (messages.done) say(messages.done, false);
  const value = typeof handle === 'function' ? await handle(result) : result;
  return { status: 'done', value, result };
}

/*
 * Reads a text file through the host picker, falling back to the caller's
 * hidden input when there is no host. `pick()` is only called in the browser
 * fallback, and it is expected to resolve to a File.
 */
export async function withTextFileRead({ pick, report, messages, handle }) {
  return withFileTransfer(
    async () => {
      const native = await readTextFileNative();
      if (native !== null) return native;
      const file = await pick();
      if (!file) return { canceled: true };
      return {
        name: String(file.name || ''),
        content: await readFileAsText(file),
      };
    },
    { report, messages, handle },
  );
}

/*
 * Writes a text file through the host save dialog, falling back to a download.
 */
export async function withTextFileWrite(
  suggestedName,
  content,
  { report, messages, handle },
) {
  return withFileTransfer(() => writeTextFile(suggestedName, content), {
    report,
    messages,
    handle,
  });
}
