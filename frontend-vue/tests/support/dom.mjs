/*
 * Mount helpers for the component tests.
 *
 * Importing this module is also the signal that the caller wants a DOM, and
 * `installDom()` must already have run by the time `vue` is first imported --
 * `@vue/runtime-dom` captures `document` at import time, so a DOM installed
 * later leaves it holding `null` and every mount fails with "Cannot read
 * properties of null (reading 'createElement')".
 *
 * So the order a test file has to keep is:
 *
 *   import { installDom } from './support/dom-globals.mjs';
 *   installDom();                                    // before any vue import
 *   const { mount } = await import('./support/dom.mjs');
 *   const { default: App } = await import('../src/App.vue');
 *
 * `dom-globals.mjs` is import-safe for exactly this reason: it pulls in no Vue
 * code, so requiring it first cannot itself trip the ordering.
 */
import { createApp, nextTick } from 'vue';
import { installDom } from './dom-globals.mjs';

export { installDom };

/** Flushes Vue's render queue; two ticks, because effects chain. */
export async function settle() {
  await nextTick();
  await nextTick();
}

/**
 * Mounts a component into a fresh container and returns it with the helpers the
 * tests use. Every mount gets its own root, so one test's DOM cannot leak into
 * the next.
 */
export function mount(component, { props = {} } = {}) {
  const window = installDom();
  const root = window.document.createElement('div');
  window.document.body.append(root);
  const app = createApp(component, props);
  app.mount(root);

  return {
    app,
    root,
    window,
    settle,
    find: (selector) => root.querySelector(selector),
    findAll: (selector) => [...root.querySelectorAll(selector)],
    text: (selector) => root.querySelector(selector)?.textContent?.trim() ?? '',
    /** Clicks the first match and flushes. Throws if nothing matches. */
    async click(selector) {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`no element matches ${selector}`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle();
    },
    /** Sets a field's value the way a user would, then fires `input`. */
    async type(selector, value) {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`no element matches ${selector}`);
      element.value = value;
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      await settle();
    },
    /** Picks a `<select>` option, which is `change` rather than `input`. */
    async select(selector, value) {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`no element matches ${selector}`);
      element.value = value;
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    },
    /** Fires a keydown on the first match. */
    async press(selector, key, init = {}) {
      const element = root.querySelector(selector);
      if (!element) throw new Error(`no element matches ${selector}`);
      element.dispatchEvent(
        new window.KeyboardEvent('keydown', { key, bubbles: true, ...init }),
      );
      await settle();
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
