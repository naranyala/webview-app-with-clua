/*
 * Tests for the workspace persistence engine.
 *
 * Everything the engine needs is injected (session refs, store, timers,
 * clock), so the whole loop is covered with plain node: the write order, the
 * debounce, the three write outcomes, and the boot/native reconciliation that
 * used to be untestable inside App.vue.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    pdfPath: ref(''),
    pdfRecentPaths: ref([]),
    pdfSessionSize: ref(0),
    pdfSourceUrl: ref(''),
    pdfDocumentId: ref(''),
    pdfPageNumber: ref(1),
    pdfZoom: ref(1.25),
    workspaceDirectory: ref('/home/writer/outline'),
    imageDirectoryName: ref('shots'),
    imageDirectoryPath: ref('/photos'),
    imageRecentPaths: ref([]),
    selectedImageGroup: ref('All Images'),
    mapPlaces: () => [
      { id: 'p1', label: 'North gate', lat: 51.5, lon: -0.12, createdAt: 1 },
    ],
    applyMapPlaces: (next) => {
      sessionsRestored.places = next;
    },
    mapSidebarOpen: ref(true),
    mapFilter: ref('none'),
    mapRenderer: ref('dom'),
    mapShowGrid: ref(false),
    mapShowCursor: ref(true),
  };
}

/* Where the persistence engine handed a restored place list back to. */
const sessionsRestored = { places: [] };

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
    sessions: options.sessions ?? fakeSessions(),
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
        path: '',
        recentPaths: [],
        size: 0,
        url: '',
        documentId: '',
        page: 1,
        zoom: 1.25,
        workspaceDirectory: '/home/writer/outline',
      },
      images: {
        directoryName: 'shots',
        directoryPath: '/photos',
        recentPaths: [],
        selectedGroup: 'All Images',
      },
      map: {
        places: [
          {
            id: 'p1',
            label: 'North gate',
            lat: 51.5,
            lon: -0.12,
            createdAt: 1,
          },
        ],
        sidebarOpen: true,
        filter: 'none',
        renderer: 'dom',
        showGrid: false,
        showCursor: true,
      },
    });
  });

  test('remembers the map view options and the saved places', () => {
    const sessions = fakeSessions();
    sessions.mapFilter.value = 'dark';
    sessions.mapRenderer.value = 'canvas';
    sessions.mapShowGrid.value = true;
    sessions.mapSidebarOpen.value = false;
    const engine = build(fakeStore(), undefined, { sessions });

    const snapshot = engine.snapshot();

    assert.equal(snapshot.map.filter, 'dark');
    assert.equal(snapshot.map.renderer, 'canvas');
    assert.equal(snapshot.map.showGrid, true);
    assert.equal(snapshot.map.sidebarOpen, false);
    assert.equal(snapshot.map.places.length, 1);
    assert.equal(snapshot.map.places[0].label, 'North gate');
  });

  test('a workspace from before the Explorer still restores', () => {
    /* No `map` field at all: the engine must not refuse the whole record. */
    const engine = build(fakeStore());
    assert.equal(engine.apply({ ...engine.snapshot(), map: undefined }), true);
  });

  test('remembers the paths a viewer has been given', () => {
    const sessions = fakeSessions();
    sessions.pdfRecentPaths.value = ['/docs/handbook.pdf'];
    sessions.imageRecentPaths.value = ['/photos', '/art'];
    const engine = build(fakeStore(), undefined, { sessions });

    const snapshot = engine.snapshot();

    assert.deepEqual(snapshot.pdf.recentPaths, ['/docs/handbook.pdf']);
    assert.deepEqual(snapshot.images.recentPaths, ['/photos', '/art']);
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

/*
 * A wiring check for the save trigger itself.
 *
 * The persistence engine has no way to know that something changed: App.vue
 * drives it entirely from a `watch([...])` list. A ref that is read by
 * snapshot() but missing from that list is silently never written - the app looks
 * correct, the value is right in memory, and it is gone after a restart.
 *
 * That is not hypothetical: the whole Explorer's state, including the saved
 * places, was missing from the list. Adding a field to snapshot() and forgetting
 * the watcher is an easy mistake to repeat, so the two are checked against each
 * other here rather than left to review.
 */
describe('the save trigger covers everything that is persisted', () => {
  const engine = readFileSync(
    new URL('../src/workspace-persistence.js', import.meta.url),
    'utf8',
  );
  const app = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

  /* Only what snapshot() reads; apply() and the helpers write state instead.
     Three shapes appear, and all three are persisted state: a plain ref, an
     optional ref, and - for the place collection - a function returning the
     array, because it is replaced wholesale rather than mutated in place. */
  const snapshotBody = engine.slice(
    engine.indexOf('function snapshot()'),
    engine.indexOf('/*\n   * Restores a snapshot'),
  );
  const persisted = new Set([
    /* sessions.name.value and sessions.name?.value */
    ...[...snapshotBody.matchAll(/sessions\.(\w+)\??\.value/g)].map(
      (m) => m[1],
    ),
    /* sessions.name() - a getter, not a ref */
    ...[...snapshotBody.matchAll(/sessions\.(\w+)\(\s*\)/g)].map((m) => m[1]),
  ]);

  /*
   * One persisted name is not the ref it reads: the place collection is passed
   * in as a getter, because the list is replaced wholesale rather than mutated in
   * place, so the sessions key and the watched ref differ. Stated here rather
   * than guessed at by the checker.
   */
  const GETTER_ALIASES = { mapPlaces: 'places' };

  const watchBody = app.slice(
    app.indexOf('watch(\n  ['),
    app.indexOf('  scheduleWorkspaceSave,'),
  );
  const watched = new Set(
    [...watchBody.matchAll(/^\s{4}(\w+),$/gm)].map((m) => m[1]),
  );

  test('the snapshot and the watcher both name real state', () => {
    /* Guards against a regex that silently matched nothing, which would make
       every other case in this block pass for the wrong reason. */
    assert.ok(persisted.size >= 22, `found ${persisted.size} persisted refs`);
    assert.ok(watched.size >= 20, `found ${watched.size} watched refs`);
  });

  test('every persisted ref is watched, so a change actually triggers a save', () => {
    const unwatched = [...persisted].filter((name) => {
      const ref = GETTER_ALIASES[name] ?? name;
      return !watched.has(ref);
    });
    assert.deepEqual(
      unwatched,
      [],
      `persisted but never watched, so never written: ${unwatched.join(', ')}`,
    );
  });

  test('the Explorer state is persisted and watched', () => {
    /* Named explicitly because this is the set that was missed: the whole
       Explorer's state, saved places included, was persisted and never
       triggered a save. */
    for (const name of [
      'mapPlaces',
      'mapSidebarOpen',
      'mapFilter',
      'mapRenderer',
      'mapShowGrid',
      'mapShowCursor',
    ]) {
      assert.ok(persisted.has(name), `${name} is not in the snapshot`);
      assert.ok(
        watched.has(GETTER_ALIASES[name] ?? name),
        `${name} is not watched`,
      );
    }
  });
});

/*
 * The debounced save never ran in the desktop app.
 *
 * The engine's default timers were a bare `{ setTimeout, clearTimeout }` pair,
 * and the debounce calls them as methods, so the receiver was the plain timers
 * object. WebKitGTK enforces the host's receiver check on Window methods, so
 * every scheduled save threw "Can only call Window.setTimeout on instances of
 * Window" and no timer was ever armed. Only the unload flush reached disk, and
 * only because it skips clearTimeout when no timer is pending.
 *
 * Node does not check the receiver, so the bug survived a full test suite and
 * two simulations. These tests install a strict global timer - one that
 * reproduces the host's receiver check - so the failure is reproducible here
 * rather than only on a user's machine.
 */
function strictGlobalTimers() {
  const scheduled = [];
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const requireWindow = (name) =>
    function (fn, ms) {
      if (this !== globalThis) {
        throw new TypeError(
          `Can only call Window.${name} on instances of Window`,
        );
      }
      return original.setTimeout(fn, ms);
    };
  const strictClear = function (handle) {
    if (this !== globalThis) {
      throw new TypeError(
        'Can only call Window.clearTimeout on instances of Window',
      );
    }
    return original.clearTimeout(handle);
  };
  globalThis.setTimeout = requireWindow('setTimeout');
  globalThis.clearTimeout = strictClear;
  return {
    original,
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
    },
  };
}

describe('the default debounce timers survive a host that checks the receiver', () => {
  test('a scheduled save actually runs when the global timer rejects a bad receiver', async () => {
    const strict = strictGlobalTimers();
    const store = fakeStore({ native: true });
    const sessions = fakeSessions();
    const engine = createWorkspacePersistence({
      sessions,
      store,
      boot: null,
      debounceMs: 5,
    });
    try {
      /* The regression: this used to throw from the watcher, leaving the saved
         state unpersisted with no error the user could act on. */
      assert.doesNotThrow(() => engine.schedule());
      /* Wait past the debounce on the real clock, which is still strict. */
      await new Promise((resolve) => strict.original.setTimeout(resolve, 30));
      const saved = store.calls.filter((call) => call.name === 'saveLocal');
      assert.equal(
        saved.length,
        1,
        'the debounced save never reached the store',
      );
      assert.deepEqual(saved[0].state.tocItems, [{ id: 'a', title: 'One' }]);
      assert.equal(
        store.calls.filter((call) => call.name === 'saveNative').length,
        1,
        'the debounced save never reached the native store',
      );
    } finally {
      strict.restore();
    }
  });

  test('the engine never captures the globals by reference', () => {
    /* A direct assertion on the mechanism, so the wrapper cannot be replaced
       by a bare capture even if the behavioural test above is weakened. */
    const source = readFileSync(
      new URL('../src/workspace-persistence.js', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(
      source,
      /timers\s*=\s*\{\s*setTimeout\s*,/,
      'the default timers must be wrappers, not the unbound globals',
    );
  });
});
