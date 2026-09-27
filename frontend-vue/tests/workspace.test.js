/*
 * Unit tests for workspace.js: schema normalization, storage round-trips,
 * legacy migration, the native bridge calls, and the persistence report that
 * drives the header pill.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWorkspaceReport,
  countWords,
  createTocItem,
  getWorkspaceReport,
  hasNativeWorkspaceStore,
  LEGACY_TOC_KEY,
  loadWorkspace,
  loadWorkspaceNative,
  normalizeWorkspace,
  outlineSummary,
  saveWorkspace,
  saveWorkspaceNative,
  serializeWorkspace,
  WORKSPACE_KEY,
} from '../src/workspace.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    has: (key) => map.has(key),
  };
}

const NATIVE_COMMANDS = ['loadWorkspace', 'saveWorkspace'];

async function withNativeBindings(bindings, run) {
  const saved = {};
  for (const name of NATIVE_COMMANDS) {
    saved[name] = Object.hasOwn(globalThis, name)
      ? globalThis[name]
      : undefined;
    if (typeof bindings[name] === 'function') globalThis[name] = bindings[name];
    else delete globalThis[name];
  }
  try {
    await run();
  } finally {
    for (const name of NATIVE_COMMANDS) {
      if (saved[name] === undefined) delete globalThis[name];
      else globalThis[name] = saved[name];
    }
  }
}

test('workspace defaults are safe when storage is empty or corrupt', () => {
  for (const storage of [
    fakeStorage(),
    fakeStorage({ [WORKSPACE_KEY]: '{' }),
  ]) {
    const workspace = loadWorkspace(storage);
    assert.equal(workspace.view, 'menu');
    assert.deepEqual(workspace.tocItems, []);
    assert.equal(workspace.activeTocId, null);
    assert.equal(workspace.editor.content, '');
    assert.equal(workspace.pdf.page, 1);
    assert.equal(workspace.pdf.url, '');
    assert.equal(workspace.images.selectedGroup, 'All Images');
  }
});

test('normalizeWorkspace rejects unknown views and clamps the session', () => {
  const workspace = normalizeWorkspace({
    view: 'root-shell',
    activeTocId: 42,
    editor: { content: 7 },
    pdf: { name: 'report.pdf', size: -5, page: 0, zoom: 99 },
    images: { selectedGroup: '' },
  });
  assert.equal(workspace.view, 'menu');
  assert.equal(workspace.activeTocId, null);
  assert.equal(workspace.editor.content, '');
  assert.equal(workspace.pdf.size, 0);
  assert.equal(workspace.pdf.page, 1);
  assert.equal(workspace.pdf.zoom, 2.5);
  assert.equal(workspace.images.selectedGroup, 'All Images');
});

test('legacy outline key is migrated when no workspace exists', () => {
  const legacy = JSON.stringify([
    { id: 'old-1', title: 'Chapter 1', level: 2, content: 'draft text' },
    { title: '   ' },
    'garbage',
  ]);
  const workspace = loadWorkspace(fakeStorage({ [LEGACY_TOC_KEY]: legacy }));
  assert.equal(workspace.tocItems.length, 1);
  assert.equal(workspace.tocItems[0].title, 'Chapter 1');
  assert.equal(workspace.tocItems[0].level, 2);
  assert.equal(workspace.tocItems[0].content, 'draft text');
  assert.equal(workspace.tocItems[0].links.pdfPage, null);
});

test('a stored workspace wins over the legacy outline key', () => {
  const storage = fakeStorage({
    [WORKSPACE_KEY]: JSON.stringify({
      view: 'toc',
      tocItems: [{ title: 'Kept', content: 'x' }],
    }),
    [LEGACY_TOC_KEY]: JSON.stringify([{ title: 'Legacy' }]),
  });
  const workspace = loadWorkspace(storage);
  assert.equal(workspace.view, 'toc');
  assert.equal(workspace.tocItems.length, 1);
  assert.equal(workspace.tocItems[0].title, 'Kept');
});

test('serializeWorkspace round-trips outline links and session state', () => {
  const state = {
    view: 'editor',
    activeTocId: 'toc-1',
    tocItems: [
      {
        id: 'toc-1',
        title: ' Methods',
        level: 9,
        content: 'body copy',
        links: { pdfPage: 12, pdfName: 'paper.pdf', images: ['a.png', '', 3] },
        updatedAt: 1700000000000,
      },
    ],
    editor: { content: 'untitled notes' },
    pdf: { name: 'paper.pdf', size: 2048, page: 12, zoom: 1.4 },
    images: { directoryName: 'figures', selectedGroup: 'Charts' },
  };
  const restored = normalizeWorkspace(JSON.parse(serializeWorkspace(state)));
  assert.equal(restored.view, 'editor');
  assert.equal(restored.activeTocId, 'toc-1');
  assert.equal(restored.tocItems[0].title, 'Methods');
  assert.equal(restored.tocItems[0].level, 3);
  assert.equal(restored.tocItems[0].links.pdfPage, 12);
  assert.deepEqual(restored.tocItems[0].links.images, ['a.png']);
  assert.equal(restored.editor.content, 'untitled notes');
  assert.equal(restored.pdf.page, 12);
  assert.equal(restored.pdf.zoom, 1.4);
  assert.equal(restored.images.directoryName, 'figures');
});

test('saveWorkspace writes a workspace the loader accepts', () => {
  const storage = fakeStorage();
  const ok = saveWorkspace(
    { view: 'toc', tocItems: [{ title: 'A' }] },
    storage,
  );
  assert.equal(ok, true);
  assert.equal(storage.has(WORKSPACE_KEY), true);
  const reloaded = loadWorkspace(storage);
  assert.equal(reloaded.view, 'toc');
  assert.equal(reloaded.tocItems[0].title, 'A');
});

test('createTocItem normalizes levels, links, and empty titles', () => {
  const item = createTocItem({
    title: '  Results ',
    level: 0,
    links: { pdfPage: '4', images: ['fig-1.png'] },
  });
  assert.equal(item.title, 'Results');
  assert.equal(item.level, 1);
  assert.equal(item.links.pdfPage, 4);
  assert.deepEqual(item.links.images, ['fig-1.png']);
  assert.equal(createTocItem({ title: '   ' }), null);
});

test('outline summary counts only sections with a draft', () => {
  assert.deepEqual(outlineSummary(undefined), { total: 0, written: 0 });
  assert.deepEqual(
    outlineSummary([
      { content: 'words here' },
      { content: '   ' },
      { content: '' },
      { content: 'two' },
    ]),
    { total: 4, written: 2 },
  );
});

test('countWords treats whitespace-only drafts as empty', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   \n\t'), 0);
  assert.equal(countWords('one two\nthree'), 3);
});

test('the native store is absent until the host exposes both bindings', async () => {
  await withNativeBindings({}, async () => {
    assert.equal(hasNativeWorkspaceStore(), false);
    assert.equal(await loadWorkspaceNative(), null);
    assert.equal(await saveWorkspaceNative('{}'), false);
  });
});

test('loadWorkspaceNative normalizes what the host returned', async () => {
  await withNativeBindings(
    {
      loadWorkspace: async () => ({
        ok: true,
        workspace: {
          savedAt: 5,
          view: 'editor',
          tocItems: [{ id: 'toc-1', title: 'Methods', content: 'draft' }],
          activeTocId: 'toc-1',
          editor: { content: 'draft' },
        },
      }),
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      const workspace = await loadWorkspaceNative();
      assert.equal(workspace.view, 'editor');
      assert.equal(workspace.savedAt, 5);
      assert.equal(workspace.tocItems[0].title, 'Methods');
      assert.equal(workspace.tocItems[0].links.pdfPage, null);
    },
  );
});

test('loadWorkspaceNative reports an empty store or a failed call as null', async () => {
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await loadWorkspaceNative(), null);
    },
  );

  await withNativeBindings(
    {
      loadWorkspace: async () => {
        throw { error: { code: 'READ_FAILED' } };
      },
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await loadWorkspaceNative(), null);
    },
  );
});

test('saveWorkspaceNative writes in order and skips identical payloads', async () => {
  const writes = [];
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async (payload) => {
        writes.push(payload);
        return { ok: true };
      },
    },
    async () => {
      assert.equal(await saveWorkspaceNative('{"savedAt":100}'), true);
      assert.equal(await saveWorkspaceNative('{"savedAt":200}'), true);
      assert.equal(await saveWorkspaceNative('{"savedAt":200}'), true);
      assert.deepEqual(writes, ['{"savedAt":100}', '{"savedAt":200}']);
    },
  );
});

test('saveWorkspaceNative rejects with the host error', async () => {
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async () => {
        throw { error: { code: 'WRITE_FAILED' } };
      },
    },
    async () => {
      assert.equal(await saveWorkspaceNative('{"savedAt":300}'), false);
    },
  );
});

test('saveWorkspace stamps savedAt and preserves a provided one', () => {
  const storage = fakeStorage();
  saveWorkspace({ view: 'menu' }, storage);
  const stamped = JSON.parse(storage.getItem(WORKSPACE_KEY));
  assert.ok(stamped.savedAt > 0);

  saveWorkspace({ view: 'pdf', savedAt: 42 }, storage);
  assert.equal(JSON.parse(storage.getItem(WORKSPACE_KEY)).savedAt, 42);
});

test('a corrupt stored workspace records a load report', () => {
  clearWorkspaceReport();
  loadWorkspace(fakeStorage({ [WORKSPACE_KEY]: '{' }));
  const report = getWorkspaceReport();
  assert.equal(report.scope, 'load');
  assert.equal(report.code, 'INVALID_CONTENT');
  assert.match(report.message, /not valid JSON/);
  clearWorkspaceReport();
});

test('loadWorkspaceNative reports the host failure instead of only logging it', async () => {
  clearWorkspaceReport();
  await withNativeBindings(
    {
      loadWorkspace: async () => {
        throw {
          error: {
            code: 'INVALID_CONTENT',
            message:
              'The saved workspace file is damaged and cannot be restored.',
          },
        };
      },
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await loadWorkspaceNative(), null);
      const report = getWorkspaceReport();
      assert.equal(report.scope, 'load');
      assert.equal(report.code, 'INVALID_CONTENT');
      assert.match(report.message, /damaged/);
    },
  );

  clearWorkspaceReport();
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: '{ "savedAt": ' }),
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await loadWorkspaceNative(), null);
      assert.equal(getWorkspaceReport().code, 'INVALID_CONTENT');
    },
  );
  clearWorkspaceReport();
});

test('an empty native store produces no report', async () => {
  clearWorkspaceReport();
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await loadWorkspaceNative(), null);
      assert.equal(getWorkspaceReport(), null);
    },
  );
});

test('a failed native save reports itself and a confirmed write clears it', async () => {
  clearWorkspaceReport();
  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async () => {
        throw {
          error: {
            code: 'WRITE_FAILED',
            message: 'the workspace file could not be written',
          },
        };
      },
    },
    async () => {
      assert.equal(await saveWorkspaceNative('{"savedAt":400}'), false);
      const report = getWorkspaceReport();
      assert.equal(report.scope, 'save');
      assert.equal(report.code, 'WRITE_FAILED');
    },
  );

  await withNativeBindings(
    {
      loadWorkspace: async () => ({ ok: true, workspace: null }),
      saveWorkspace: async () => ({ ok: true }),
    },
    async () => {
      assert.equal(await saveWorkspaceNative('{"savedAt":500}'), true);
      assert.equal(getWorkspaceReport(), null);
    },
  );
});

test('a rejected local save records a write failure the UI can show', () => {
  clearWorkspaceReport();
  const storage = fakeStorage();
  storage.setItem = () => {
    throw new Error('disk unavailable');
  };

  assert.equal(saveWorkspace({ view: 'menu' }, storage), false);

  const report = getWorkspaceReport();
  assert.equal(report.scope, 'save');
  assert.equal(report.code, 'WRITE_FAILED');
  assert.match(report.message, /could not be saved/);
  clearWorkspaceReport();
});

test('a full browser quota explains itself instead of failing silently', () => {
  clearWorkspaceReport();
  const quota = new Error('full');
  quota.name = 'QuotaExceededError';
  const storage = fakeStorage();
  storage.setItem = () => {
    throw quota;
  };

  assert.equal(saveWorkspace({ view: 'menu' }, storage), false);
  assert.equal(
    getWorkspaceReport().message,
    'Browser workspace storage is full.',
  );
  clearWorkspaceReport();
});

test('storage without write access reports the reason', () => {
  clearWorkspaceReport();
  assert.equal(saveWorkspace({ view: 'menu' }, null), false);
  const report = getWorkspaceReport();
  assert.equal(report.scope, 'save');
  assert.equal(report.code, 'WRITE_FAILED');
  assert.match(report.message, /does not allow local workspace storage/);
  clearWorkspaceReport();
});

test('a confirmed write clears a save problem but not a load one', () => {
  clearWorkspaceReport();
  const failing = fakeStorage();
  failing.setItem = () => {
    throw new Error('busy');
  };
  saveWorkspace({ view: 'menu' }, failing);
  assert.equal(getWorkspaceReport().scope, 'save');

  const storage = fakeStorage();
  assert.equal(saveWorkspace({ view: 'pdf' }, storage), true);
  assert.equal(getWorkspaceReport(), null);

  loadWorkspace(fakeStorage({ [WORKSPACE_KEY]: '{' }));
  assert.equal(getWorkspaceReport().scope, 'load');
  assert.equal(saveWorkspace({ view: 'pdf' }, storage), true);
  assert.equal(getWorkspaceReport().scope, 'load');
  clearWorkspaceReport();
});

test('a non-array legacy outline key is ignored', () => {
  clearWorkspaceReport();
  const workspace = loadWorkspace(
    fakeStorage({ [LEGACY_TOC_KEY]: '{"title":"not an array"}' }),
  );
  assert.deepEqual(workspace.tocItems, []);
  assert.equal(workspace.view, 'menu');
  assert.equal(getWorkspaceReport(), null);
});

test('normalizing a non-object workspace yields the defaults', () => {
  for (const value of [null, 'text', 42, [], undefined]) {
    const workspace = normalizeWorkspace(value);
    assert.equal(workspace.view, 'menu');
    assert.equal(workspace.pdf.page, 1);
    assert.equal(workspace.tocItems.length, 0);
  }
});

test('serializing drops unknown fields and re-applies the clamps', () => {
  const parsed = JSON.parse(
    serializeWorkspace({ view: 'pdf', bogus: true, pdf: { zoom: 99 } }),
  );
  assert.equal(parsed.bogus, undefined);
  assert.equal(parsed.view, 'pdf');
  assert.equal(parsed.pdf.zoom, 2.5);
  assert.equal(parsed.version, 1);
});

test('the native store needs both bindings, not just one', async () => {
  await withNativeBindings(
    { loadWorkspace: async () => ({ ok: true, workspace: null }) },
    async () => {
      assert.equal(hasNativeWorkspaceStore(), false);
      assert.equal(await saveWorkspaceNative('{}'), false);
    },
  );
  await withNativeBindings(
    { saveWorkspace: async () => ({ ok: true }) },
    async () => {
      assert.equal(hasNativeWorkspaceStore(), false);
      assert.equal(await loadWorkspaceNative(), null);
    },
  );
});
