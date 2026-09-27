/*
 * Unit tests for the combined-outline PDF session: the workspace folder, the
 * combine action, and what the host is asked to write.
 *
 * The folder is the interesting part. The webview never names a path to write
 * into - the host owns it - so these cases pin that the session only ever reports
 * a path back, and that a cancel or a host failure leaves the stored folder
 * alone rather than half-updating it.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { runNativeCall } from '../src/native-bridge.js';

import { createOutlinePdfSession } from '../src/outline-pdf.js';

const originalWindow = globalThis.window;
globalThis.window = {};

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

/* A session whose host bindings come from a table instead of window. */
function sessionWith(host, boot = {}) {
  return createOutlinePdfSession({
    boot: {
      pdf: { workspaceDirectory: '', ...(boot.pdf ?? {}) },
    },
    native: (name) => (name in host ? host[name] : null),
    /* The real wrapper, so a rejected host call arrives as the
       { error: { message } } shape the status line actually reads. */
    call: runNativeCall,
  });
}

test('a fresh session explains that no folder has been chosen', () => {
  const session = sessionWith({});
  assert.equal(session.workspaceDirectory.value, '');
  assert.match(session.outlinePdfStatus.value, /Choose a workspace folder/);
  assert.equal(session.outlinePdfStatusError.value, false);
});

test('the stored folder is only shown, and is reported in the status', () => {
  const session = sessionWith(
    {},
    { pdf: { workspaceDirectory: '/home/w/out' } },
  );
  assert.equal(session.workspaceDirectory.value, '/home/w/out');
  assert.match(session.outlinePdfStatus.value, /\/home\/w\/out/);
});

test('choosing a folder stores and reports the path the host returned', async () => {
  const session = sessionWith({
    chooseOutlineDirectory: () => Promise.resolve({ path: '/home/w/docs' }),
  });

  const chosen = await session.chooseWorkspaceDirectory();

  assert.equal(chosen, '/home/w/docs');
  assert.equal(session.workspaceDirectory.value, '/home/w/docs');
  assert.equal(session.outlinePdfStatusError.value, false);
  assert.match(session.outlinePdfStatus.value, /written to \/home\/w\/docs/);
});

test('a cancelled folder choice leaves the stored folder untouched', async () => {
  const session = sessionWith(
    { chooseOutlineDirectory: () => Promise.resolve({ canceled: true }) },
    { pdf: { workspaceDirectory: '/home/w/old' } },
  );

  assert.equal(await session.chooseWorkspaceDirectory(), null);
  assert.equal(session.workspaceDirectory.value, '/home/w/old');
  assert.equal(session.outlinePdfStatusError.value, false);
  assert.match(session.outlinePdfStatus.value, /cancelled/);
});

test('choosing a folder is desktop-only', async () => {
  const session = sessionWith({});

  assert.equal(await session.chooseWorkspaceDirectory(), null);
  assert.equal(session.outlinePdfStatusError.value, true);
  assert.match(session.outlinePdfStatus.value, /desktop app/);
});

test('a folder answer with no path is treated as a failure', async () => {
  const session = sessionWith({
    chooseOutlineDirectory: () => Promise.resolve({}),
  });

  assert.equal(await session.chooseWorkspaceDirectory(), null);
  assert.equal(session.outlinePdfStatusError.value, true);
  assert.equal(session.workspaceDirectory.value, '');
});

test('combining sends the name and the outline JSON to the host', async () => {
  const asked = [];
  const session = sessionWith({
    renderOutlinePdf: (name, json) => {
      asked.push({ name, json });
      return Promise.resolve({
        path: '/home/w/docs/report.pdf',
        name: 'report.pdf',
        pages: 4,
        bytes: 20480,
      });
    },
  });

  const written = await session.renderOutlinePdf('{"items":[]}', 'report');

  assert.equal(asked.length, 1);
  assert.equal(asked[0].name, 'report');
  assert.equal(asked[0].json, '{"items":[]}');
  assert.equal(written.path, '/home/w/docs/report.pdf');
  assert.equal(written.pages, 4);
  assert.deepEqual(session.lastOutlinePdf.value, {
    path: '/home/w/docs/report.pdf',
    name: 'report.pdf',
    pages: 4,
    bytes: 20480,
  });
  assert.equal(session.outlinePdfBusy.value, false, 'the busy flag is cleared');
});

test('the status and the summary report the page count and size', async () => {
  const session = sessionWith({
    renderOutlinePdf: () =>
      Promise.resolve({
        path: '/d/a.pdf',
        name: 'a.pdf',
        pages: 1,
        bytes: 512,
      }),
  });

  await session.renderOutlinePdf('{}', 'a');

  assert.match(session.outlinePdfStatus.value, /1 page\./);
  assert.equal(session.outlinePdfSummary.value, 'a.pdf · 1 page · 1 kB');
});

test('a host failure reports itself and records no file', async () => {
  const session = sessionWith({
    renderOutlinePdf: () =>
      Promise.reject({
        error: { code: 'NO_WORKSPACE_DIRECTORY', message: 'pick one' },
      }),
  });

  assert.equal(await session.renderOutlinePdf('{}', 'a'), null);
  assert.equal(session.lastOutlinePdf.value, null);
  assert.equal(session.outlinePdfStatusError.value, true);
  assert.equal(session.outlinePdfStatus.value, 'pick one');
  assert.equal(session.outlinePdfBusy.value, false);
});

test('an empty outline is refused before the host is asked', async () => {
  let asked = 0;
  const session = sessionWith({
    renderOutlinePdf: () => {
      asked += 1;
      return Promise.resolve({ path: '/d/a.pdf' });
    },
  });

  assert.equal(await session.renderOutlinePdf('   ', 'a'), null);
  assert.equal(asked, 0, 'the host is never called for nothing to combine');
  assert.equal(session.outlinePdfStatusError.value, true);
});

test('combining is desktop-only', async () => {
  const session = sessionWith({});

  assert.equal(await session.renderOutlinePdf('{}', 'a'), null);
  assert.equal(session.outlinePdfStatusError.value, true);
  assert.match(session.outlinePdfStatus.value, /desktop app/);
});

test('an answer with no path is not treated as a written file', async () => {
  const session = sessionWith({
    renderOutlinePdf: () => Promise.resolve({ pages: 2 }),
  });

  assert.equal(await session.renderOutlinePdf('{}', 'a'), null);
  assert.equal(session.lastOutlinePdf.value, null);
  assert.equal(session.outlinePdfStatusError.value, true);
});

test('two sessions keep their own folder and last file', () => {
  const first = sessionWith({});
  const second = sessionWith({}, { pdf: { workspaceDirectory: '/second' } });

  first.workspaceDirectory.value = '/first';

  assert.equal(second.workspaceDirectory.value, '/second');
  assert.equal(first.lastOutlinePdf.value, null);
  assert.equal(second.lastOutlinePdf.value, null);
});
