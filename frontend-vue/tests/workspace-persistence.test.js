/*
 * Tests for the workspace persistence engine.
 *
 * Everything the engine needs is injected (session refs, store, timers,
 * clock), so the whole loop is covered with plain node: the write order, the
 * debounce, the three write outcomes, and the boot/native reconciliation that
 * used to be untestable inside App.vue.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ref } from 'vue';

import { createWorkspacePersistence } from '../src/workspace-persistence.js';

/* A session bag with one ref per persisted field, all with sane defaults. */
function fakeSessions() {
  return {
    view: ref('menu'),
    tocItems: ref([{ id: 'a', title: 'One' }]),
    activeTocId: ref('a'),
    linkTargetId: ref(null),
    editorContent: ref('draft text'),
    pdfName: ref('No document selected'),
    pdfSessionSize: ref(0),
    pdfSourceUrl: ref(''),
    pdfDocumentId: ref(''),
    pdfPageNumber: ref(1),
    pdfZoom: ref(1.25),
    imageDirectoryName: ref('shots'),
    selectedImageGroup: ref('All Images'),
  };
}

/* A store whose local, native, and report behavior each test controls. */
function fakeStore({
  native = false,
  saveLocal = true,
  saveNativeResult = true,
  nativeWorkspace = null,
  interacted = false,
} = {}) {
  const calls = [];
  let report = null;
  return {
    calls,
    setReport(value) {
      report = value;
    },
    hasNativeWorkspaceStore: () => native,
    serializeWorkspace: (state) => JSON.stringify(state),
    saveWorkspace: (state) => {
      calls.push({ name: 'saveLocal', state });
      return saveLocal;
    },
    loadWorkspaceNative: async () => {
      calls.push({ name: 'loadNative' });
      return nativeWorkspace;
    },
    saveWorkspaceNative: async (payload) => {
      calls.push({ name: 'saveNative', payload });
      return saveNativeResult;
    },
    getWorkspaceReport: () => report,
    hasUserInteracted: () => interacted,
  };
}

/* A timer that records what was scheduled and runs it on demand. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimeout: (id) => {
      scheduled[id - 1] = null;
    },
    run: () => {
      const pending = scheduled.splice(0, scheduled.length).filter(Boolean);
      for (const entry of pending) entry.callback();
      return pending.length;
    },
  };
}

function build(store, timers, options = {}) {
  return createWorkspacePersistence({
    sessions: fakeSessions(),
    store,
    boot: { savedAt: 0 },
    now: () => 1_700_000_000_000,
    timers: timers ?? fakeTimers(),
    onPersistenceFailure: options.onPersistenceFailure ?? null,
  });
}

/* Lets the engine's internal promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('the snapshot', () => {
  test('is built from the session refs in one place', () => {
    const engine = build(fakeStore());
    assert.deepEqual(engine.snapshot(), {
      view: 'menu',
      tocItems: [{ id: 'a', title: 'One' }],
      activeTocId: 'a',
      editor: { content: 'draft text' },
      pdf: {
        name: 'No document selected',
        size: 0,
        url: '',
        documentId: '',
        page: 1,
        zoom: 1.25,
      },
      images: { directoryName: 'shots', selectedGroup: 'All Images' },
    });
  });

  test('stamps savedAt from the injected clock', () => {
    const store = fakeStore();
    build(store).persist();
    assert.equal(store.calls[0].state.savedAt, 1_700_000_000_000);
  });
});

describe('persisting without a native store', () => {
  test('a successful local write reports the local mode', async () => {
    const store = fakeStore({ saveLocal: true });
    const engine = build(store);
    assert.equal(engine.persist(), true);
    await settle();
    assert.equal(engine.persistenceMode.value, 'local');
    assert.deepEqual(
      store.calls.map((call) => call.name),
      ['saveLocal'],
    );
    assert.equal(store.calls[0].state.savedAt, 1_700_000_000_000);
  });

  test('a failed local write reports no mode and returns false', async () => {
    const engine = build(fakeStore({ saveLocal: false }));
    assert.equal(engine.persist(), false);
    await settle();
    assert.equal(engine.persistenceMode.value, 'none');
  });
});

describe('persisting with a native store', () => {
  test('the local write happens first, then the native one', async () => {
    const store = fakeStore({ native: true, saveNativeResult: true });
    const engine = build(store);
    assert.equal(engine.persist(), true);
    await settle();
    assert.deepEqual(
      store.calls.map((call) => call.name),
      ['saveLocal', 'saveNative'],
    );
    assert.equal(engine.persistenceMode.value, 'native');
  });

  test('the native payload is the serialized snapshot', async () => {
    const store = fakeStore({ native: true });
    const engine = build(store);
    engine.persist();
    await settle();
    const payload = JSON.parse(store.calls[1].payload);
    assert.equal(payload.view, 'menu');
    assert.equal(payload.editor.content, 'draft text');
  });

  test('a native failure with a working local cache degrades quietly', async () => {
    const failures = [];
    const store = fakeStore({
      native: true,
      saveNativeResult: false,
      saveLocal: true,
    });
    const engine = build(store, fakeTimers(), {
      onPersistenceFailure: (m) => failures.push(m),
    });
    assert.equal(engine.persist(), true);
    await settle();
    assert.equal(engine.persistenceMode.value, 'local');
    assert.deepEqual(failures, []);
  });

  test('a failure in both stores is escalated to the caller', async () => {
    const failures = [];
    const store = fakeStore({
      native: true,
      saveNativeResult: false,
      saveLocal: false,
    });
    const engine = build(store, fakeTimers(), {
      onPersistenceFailure: (m) => failures.push(m),
    });
    assert.equal(engine.persist(), false);
    await settle();
    assert.equal(engine.persistenceMode.value, 'none');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /could not be saved to this device/);
  });

  test('the mode starts as native when the host offers the store', () => {
    const engine = build(fakeStore({ native: true }));
    assert.equal(engine.persistenceMode.value, 'native');
  });
});

describe('the debounce', () => {
  test('several schedules collapse into one write', () => {
    const store = fakeStore();
    const timers = fakeTimers();
    const engine = build(store, timers);

    engine.schedule();
    engine.schedule();
    engine.schedule();
    assert.equal(store.calls.length, 0);
    assert.equal(timers.scheduled.length, 3);
    assert.equal(timers.run(), 1);
    assert.equal(store.calls.length, 1);
  });

  test('the delay is the documented one', () => {
    const timers = fakeTimers();
    build(fakeStore(), timers).schedule();
    assert.equal(timers.scheduled[0].delay, 250);
  });

  test('flush writes immediately and cancels the pending timer', () => {
    const store = fakeStore();
    const timers = fakeTimers();
    const engine = build(store, timers);

    engine.schedule();
    engine.flush();
    assert.equal(store.calls.length, 1);
    assert.equal(timers.run(), 0);
  });
});

describe('hydration', () => {
  const native = {
    savedAt: 500,
    view: 'pdf',
    tocItems: [{ id: 'z', title: 'From disk' }],
    activeTocId: 'z',
    editor: { content: 'restored draft' },
    pdf: {
      name: 'doc.pdf',
      size: 10,
      url: 'file:///doc.pdf',
      documentId: 'd1',
      page: 4,
      zoom: 2,
    },
    images: { directoryName: 'pics', selectedGroup: 'All Images' },
  };

  test('a newer native copy wins', async () => {
    const engine = build(fakeStore({ native: true, nativeWorkspace: native }));
    assert.equal(await engine.hydrate(), true);
    assert.equal(engine.snapshot().view, 'pdf');
    assert.equal(engine.snapshot().editor.content, 'restored draft');
  });

  test('an older native copy is ignored', async () => {
    const engine = build(
      fakeStore({ native: true, nativeWorkspace: { ...native, savedAt: -1 } }),
    );
    assert.equal(await engine.hydrate(), false);
    assert.equal(engine.snapshot().view, 'menu');
  });

  test('a tie keeps the native copy', async () => {
    const engine = build(
      fakeStore({ native: true, nativeWorkspace: { ...native, savedAt: 0 } }),
    );
    assert.equal(await engine.hydrate(), true);
  });

  test('an empty store keeps the boot state', async () => {
    const engine = build(fakeStore({ native: true, nativeWorkspace: null }));
    assert.equal(await engine.hydrate(), false);
    assert.equal(engine.snapshot().view, 'menu');
  });

  test('user interaction short-circuits the load', async () => {
    const store = fakeStore({
      native: true,
      nativeWorkspace: native,
      interacted: true,
    });
    const engine = build(store);
    assert.equal(await engine.hydrate(), false);
    assert.equal(store.calls.length, 0);
  });

  test('no native store means no hydration at all', async () => {
    const store = fakeStore({ native: false, nativeWorkspace: native });
    assert.equal(await build(store).hydrate(), false);
    assert.equal(store.calls.length, 0);
  });
});

describe('restoring a snapshot', () => {
  test('a missing snapshot is reported, not applied', () => {
    assert.equal(build(fakeStore()).apply(null), false);
  });

  test('an unknown active id falls back to the first item', () => {
    const engine = build(fakeStore());
    const applied = engine.apply({
      view: 'toc',
      tocItems: [{ id: 'one' }, { id: 'two' }],
      activeTocId: 'missing',
      editor: { content: '' },
      pdf: {},
      images: {},
    });
    assert.equal(applied, true);
    assert.equal(engine.snapshot().activeTocId, null);
    assert.equal(engine.snapshot().tocItems.length, 2);
  });

  test('an empty pdf name keeps the placeholder', () => {
    const engine = build(fakeStore());
    engine.apply({
      view: 'menu',
      tocItems: [],
      activeTocId: null,
      editor: { content: '' },
      pdf: { name: '' },
      images: {},
    });
    assert.equal(engine.snapshot().pdf.name, 'No document selected');
  });
});

describe('the header report', () => {
  test('mirrors the store report and can be refreshed', () => {
    const store = fakeStore();
    const engine = build(store);
    assert.equal(engine.workspaceReport.value, null);
    store.setReport({ scope: 'save', code: 'WRITE_FAILED', message: 'nope' });
    engine.refreshReport();
    assert.equal(engine.workspaceReport.value.scope, 'save');
    assert.equal(engine.workspaceReport.value.code, 'WRITE_FAILED');
    assert.match(engine.workspaceReport.value.text, /not saved/i);
  });
});
