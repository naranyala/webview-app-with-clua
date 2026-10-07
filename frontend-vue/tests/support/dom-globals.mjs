/*
 * Installs the jsdom window as the process globals.
 *
 * This module deliberately imports nothing from `vue`. `@vue/runtime-dom`
 * captures `document` at import time, so the globals have to exist before any
 * module that pulls Vue in is evaluated; a helper that imported `createApp`
 * itself would defeat the ordering it is here to establish. The mount helpers
 * live in `dom.mjs`, which is imported *after* this one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/*
 * The document is built from `public/index.html`, not a bare `<div>`. That is
 * the exact markup the WebView parses before Vue boots, so a shell that has
 * stopped parsing fails here rather than in the desktop app.
 */
const SHELL = readFileSync(
  fileURLToPath(new URL('../../public/index.html', import.meta.url)),
  'utf8',
);

let window = null;

export function installDom() {
  if (window) return window;
  window = new JSDOM(SHELL, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  }).window;

  // Node has no matchMedia; a component could query it, and an undefined
  // function is a worse failure than a stub.
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
  }

  for (const key of [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'localStorage',
    'sessionStorage',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'DOMParser',
    'XMLHttpRequest',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'InputEvent',
    'FocusEvent',
    'PointerEvent',
    'WheelEvent',
    'DragEvent',
    'ClipboardEvent',
    'File',
    'FileList',
    'FileReader',
    'Blob',
    'FormData',
    'Image',
    'URL',
  ]) {
    if (window[key] === undefined) continue;
    // defineProperty, not assignment: Node defines some of these itself
    // (`navigator` is a getter-only global since v21), where a plain assignment
    // throws instead of overriding.
    Object.defineProperty(globalThis, key, {
      value: window[key],
      writable: true,
      configurable: true,
    });
  }

  /*
   * Every DOM interface class, because Vue's runtime-dom resolves them off the
   * global scope when it mounts (SVGElement, MathMLElement, and the rest).
   * Naming only the ones it uses today would turn the next one into an
   * "X is not defined" crash rather than a test failure.
   */
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue;
    if (!/^[A-Z]/.test(key)) continue;
    if (typeof window[key] !== 'function') continue;
    Object.defineProperty(globalThis, key, {
      value: window[key],
      writable: true,
      configurable: true,
    });
  }
  return window;
}

/** The bindings `src/webview_app.c` registers, so the fake matches the host. */
export const NATIVE_BINDINGS = [
  'summarize',
  'openPdf',
  'extractPdfToc',
  'openImageDirectory',
  'loadWorkspace',
  'saveWorkspace',
  'openTextFile',
  'saveTextFile',
];

/**
 * Installs a fake native host on `window`, so a component path that calls a
 * binding can be exercised. Returns a recorder: `calls` is every
 * `[name, args]` in order, and `reply` is what the next call to `name` returns.
 *
 * Each entry is either a value (returned) or a function `(args) => value`,
 * which is how a test makes one call fail and the next succeed.
 */
export function installNativeHost(replies = {}) {
  const window = installDom();
  const calls = [];
  const queue = { ...replies };

  window.__nativeCalls = calls;
  for (const name of NATIVE_BINDINGS) {
    window[name] = (...args) => {
      calls.push([name, args]);
      const reply = queue[name];
      if (typeof reply === 'function') return reply(args);
      if (reply === undefined) return { ok: true };
      return reply;
    };
  }
  return { calls, reply: queue, window };
}

/** Removes the fake bindings, restoring the no-host state. */
export function removeNativeHost() {
  const window = installDom();
  for (const name of NATIVE_BINDINGS) delete window[name];
  delete window.__nativeCalls;
}
