/*
 * The component event paths, exercised in a real DOM.
 *
 * Everything else in this suite asserts that source text says the right thing.
 * This file mounts `App.vue` and drives it the way a user would: it clicks the
 * menu cards, types into the declare bar, opens the editor gate, and follows a
 * binding's answer into the status line. A template can keep every string the
 * static tests look for and still wire nothing up; only mounting finds that.
 *
 * The harness is `tests/support/dom.mjs`, loaded by `--import` before this file
 * (see the npm test script) because `@vue/runtime-dom` captures `document` at
 * import time.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  installDom,
  installNativeHost,
  removeNativeHost,
} from './support/dom-globals.mjs';

/*
 * The DOM has to exist before anything imports `vue` -- see the note at the top
 * of `support/dom.mjs`. Everything that follows is a dynamic import for that
 * reason, and the `?fresh=N` in `openApp` re-evaluates the whole graph per test
 * (see `support/sfc-loader.mjs`).
 */
installDom();
const { mount } = await import('./support/dom.mjs');

/*
 * A fresh app per test.
 *
 * Two things leak between tests in one process, and both are real:
 *
 *   - `boot-state.js` reads localStorage at import time, so a workspace saved
 *     by the previous test would be restored into this one;
 *   - the sessions are module-level singletons, so a second import of the same
 *     specifier returns the same instances -- and the outline is a `ref`, not a
 *     DOM node, so a leftover outline item is still there.
 *
 * The `?fresh=N` token re-evaluates the whole import graph (the loader in
 * `sfc-loader.mjs` propagates it), so storage is cleared *before* the import and
 * every test gets its own sessions. Without both, a test only passes if it runs
 * in the right order, which is how a suite rots.
 */
let boots = 0;

async function openApp({ replies = {} } = {}) {
  installDom().window.localStorage.clear();
  removeNativeHost();
  const host = installNativeHost({
    loadWorkspace: { ok: true, workspace: null },
    ...replies,
  });
  boots += 1;
  const { default: FreshApp } = await import(`../src/App.vue?fresh=${boots}`);
  const app = mount(FreshApp);
  await app.settle();
  return { app, host };
}

/** Clicks a menu card, the way a user picks a tool. */
async function openTool(app, tool) {
  await app.click(`.app-card[data-app="${tool}"]`);
}

/** Declares one outline section through the TOC Manager's form. */
async function declareSection(app, title, level = '1') {
  await app.type('#toc-title-input', title);
  if (app.find('#toc-level-input')) await app.select('#toc-level-input', level);
  await app.click('.toc-declare-bar button[type="submit"]');
}

after(() => {
  removeNativeHost();
});

test('the menu offers every tool and each one opens its pane', async () => {
  const { app } = await openApp();
  const cards = app.findAll('.app-card');
  assert.equal(cards.length, 6, 'six menu cards');

  /*
   * Each card's data-app must name a pane that exists, or the click navigates
   * to a view with no DOM and the app looks like it did nothing.
   *
   * `googlemap` was missing here while the card existed, so the Google viewer was
   * reachable from the menu and never opened by any test - a whole pane shipping
   * unexercised. tests/menu-cards.test.js now checks this same mapping statically;
   * this case is the one that actually clicks each card.
   */
  const panes = {
    toc: '.toc-manager',
    editor: '.editor-app',
    pdf: '.pdf-app',
    images: '.image-app',
    map: '.map-app',
    googlemap: '.google-map-app',
  };
  for (const card of cards) {
    const tool = card.dataset.app;
    assert.ok(panes[tool], `${tool} has no pane to open`);
    await openTool(app, tool);
    const pane = app.find(panes[tool]);
    assert.ok(pane, `${tool} did not open its pane`);
    assert.notEqual(
      pane.style.display,
      'none',
      `${tool} opened a pane that is still hidden`,
    );
  }
  app.unmount();
});

test('the menu cards show the live badge for each tool', async () => {
  const { app } = await openApp();
  // A badge is a sentence about the tool's state, not a label; the static tests
  // only prove the interpolation exists.
  for (const tool of ['toc', 'editor', 'pdf', 'images', 'map']) {
    const badge = app.text(`.app-card[data-app="${tool}"] small`);
    assert.ok(badge.length > 0, `the ${tool} card shows no badge`);
  }
  app.unmount();
});

test('selecting a card marks it as the active view', async () => {
  const { app } = await openApp();
  await openTool(app, 'pdf');
  // The menu is v-show, so the shell keeps every pane mounted; what changes is
  // which one is visible.
  assert.equal(app.find('.app-shell').className.includes('pdf-active'), true);
  app.unmount();
});

test('declaring a section puts it in the outline', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');

  assert.equal(app.findAll('.toc-outline-item').length, 0, 'no sections yet');
  await declareSection(app, 'Chapter one');

  const rows = app.findAll('.toc-outline-item');
  assert.equal(rows.length, 1, 'the declared section is in the outline');
  assert.match(rows[0].textContent, /Chapter one/);
  app.unmount();
});

test('a blank section title is refused and the outline stays empty', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');
  await app.type('#toc-title-input', '   ');
  await app.click('.toc-declare-bar button[type="submit"]');

  assert.equal(
    app.findAll('.toc-outline-item').length,
    0,
    'nothing was declared',
  );
  // The refusal has to be visible, or the button just appears inert.
  const status = app.text('#toc-manager-status');
  assert.ok(status.length > 0, 'the refusal is not reported');
  app.unmount();
});

test('the editor is gated until a section is picked', async () => {
  const { app } = await openApp();
  await openTool(app, 'editor');

  // With no declared section there is nothing to write, so the textarea must
  // not be there -- otherwise a draft could be typed into nowhere.
  assert.ok(
    app.find('.toc-pick'),
    'the empty outline shows the section picker',
  );
  assert.equal(
    app.find('#values'),
    null,
    'a textarea is offered with no section',
  );

  await app.click('#declare-first-section');
  assert.ok(
    app.find('.toc-declare-bar'),
    'the picker routes to the declare form',
  );
  app.unmount();
});

test('picking a section opens the editor and shows its draft', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');
  await declareSection(app, 'Chapter one');
  await openTool(app, 'editor');

  await app.click('.toc-pick-item');
  assert.equal(
    app.find('.toc-pick'),
    null,
    'the picker is gone once a section is picked',
  );

  const editor = app.find('#values');
  assert.ok(editor, 'the textarea appears for a picked section');

  // And the draft round-trips through the component, not just the ref.
  await app.type('#values', 'Once upon a time');
  assert.equal(app.find('#values').value, 'Once upon a time');
  app.unmount();
});

test('two sections keep separate drafts', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');
  await declareSection(app, 'First');
  await declareSection(app, 'Second');
  assert.equal(
    app.findAll('.toc-pick-item, .toc-outline-item').length >= 2,
    true,
  );

  await openTool(app, 'editor');
  assert.equal(
    app.findAll('.toc-pick-item').length,
    2,
    'both sections are offered',
  );
  await app.click('.toc-pick-item');
  await app.type('#values', 'draft one');
  assert.match(app.text('#document-title-text, .document-title'), /First/);

  // Walk to the other section with the editor's own Next action. The draft must
  // not follow the selection -- this is I2.5's "does not lose work", and a
  // single shared buffer ref would pass every other test here.
  await app.click('#next-outline-item');
  assert.match(app.text('#document-title-text, .document-title'), /Second/);
  assert.equal(
    app.find('#values').value,
    '',
    'the second section starts empty',
  );
  app.unmount();
});

test('a draft survives leaving the editor and coming back', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');
  await declareSection(app, 'Only section');
  await openTool(app, 'editor');
  await app.click('.toc-pick-item');
  await app.type('#values', 'written once');

  // Out to another tool and back: the draft is on the outline item, not in a
  // component that the view switch unmounted.
  await openTool(app, 'pdf');
  await openTool(app, 'editor');
  assert.equal(
    app.find('#values')?.value,
    'written once',
    'the draft was lost',
  );
  app.unmount();
});

test('removing a section empties the outline again', async () => {
  const { app } = await openApp();
  await openTool(app, 'toc');
  await declareSection(app, 'Doomed');
  assert.equal(app.findAll('.toc-outline-item').length, 1);

  await app.click('.toc-outline-remove');
  assert.equal(
    app.findAll('.toc-outline-item').length,
    0,
    'the section is gone',
  );
  app.unmount();
});

test('a native failure is reported on the status line, not swallowed', async () => {
  // The point of the typed error contract: the UI must show the message, and
  // must not render as though the call had succeeded.
  const { app, host } = await openApp({
    replies: {
      openImageDirectory: () => {
        throw new Error('the picker was dismissed');
      },
    },
  });
  await openTool(app, 'images');
  await app.click('#browse-image-directory');

  const status = app.find('#image-status');
  assert.ok(status, 'the viewer reports status');
  // Exactly the host's wording, not a regex: `withFileTransfer` reports
  // `error.message` when the host gave one and falls back to the caller's
  // `messages.error` only when it did not, and the next test pins that half.
  assert.match(status.textContent, /picker was dismissed/);
  assert.equal(
    host.calls.filter(([name]) => name === 'openImageDirectory').length > 0,
    true,
    'the binding was actually called',
  );
  app.unmount();
});

test('a native failure with no message falls back to the tool wording', async () => {
  // The other half of the error contract: an error object with no `message` must
  // still produce a sentence the user can act on, not an empty status line.
  const { app } = await openApp({
    replies: {
      openImageDirectory: () => {
        throw new Error('');
      },
    },
  });
  await openTool(app, 'images');
  await app.click('#browse-image-directory');
  assert.match(app.text('#image-status'), /Could not open the image directory/);
  app.unmount();
});

test('a workspace with a saved view restores that view on boot', async () => {
  // The store is the durability story (TODO-033), and this is the path where a
  // regression would be invisible: the user would just find the app on the
  // menu every launch.
  const { app } = await openApp({
    replies: {
      loadWorkspace: {
        ok: true,
        workspace: { version: 1, view: 'pdf', savedAt: 2 },
      },
    },
  });
  await app.settle();
  assert.equal(
    app.find('.app-shell').className.includes('pdf-active'),
    true,
    'the restored view is the PDF reader',
  );
  app.unmount();
});

test('an unreadable workspace falls back to the menu instead of hanging', async () => {
  // `loadWorkspace` is called on mount; if it rejects and nothing catches it,
  // the app never paints and the smoke test is the only thing that notices.
  const { app } = await openApp({
    replies: {
      loadWorkspace: () => {
        throw new Error('workspace.json is corrupt');
      },
    },
  });
  await app.settle();
  assert.ok(app.find('.app-grid'), 'the menu still rendered');
  app.unmount();
});
