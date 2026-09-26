import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countWords,
  createTocItem,
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
