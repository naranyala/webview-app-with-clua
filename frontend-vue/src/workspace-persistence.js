/*
 * The workspace persistence engine.
 *
 * This used to live inside App.vue, where the snapshot shape, the 250 ms
 * debounce, the localStorage-then-native write order, and the boot/native
 * reconciliation were all untestable and the snapshot was a second copy of the
 * schema that workspace.js owns. It is here now with every dependency injected
 * (sessions, store, timers, clock), so tests/workspace-persistence.test.js can
 * drive the whole loop — including the failure paths — with plain node.
 *
 * Contract for the caller:
 *   - persist() reports the *synchronous* local write, because that is the
 *     only part a button handler can act on. The native write finishes later
 *     and reports through the header pill, persistenceMode, and the
 *     onPersistenceFailure callback.
 *   - The snapshot below is the single definition of what gets persisted.
 *     workspace.js's normalizeWorkspace stays the only validator.
 */

import { computed, ref } from 'vue';
import { GOOGLE_MAP_LAYERS } from './workspace.js';
import { formatWorkspaceReport } from './workspace-report.js';

const SAVE_DEBOUNCE_MS = 250;

const SAVE_FAILURE_MESSAGE = 'The workspace could not be saved to this device.';

/*
 * sessions: the refs the four tools own (see App.vue's import list).
 * store:   workspace.js's persistence surface.
 * boot:    the boot snapshot from boot-state.js.
 */
/*
 * The debounce calls its timers as methods of this object, so `this` is the
 * object rather than the window. WebKitGTK enforces the host's receiver check on
 * Window methods and throws "Can only call Window.setTimeout on instances of
 * Window" if the receiver is not a Window - which, in the desktop host, meant
 * the debounced save never ran and only the unload flush ever reached disk.
 * Node does not check the receiver, so a bare capture passes every test here and
 * fails silently in the only environment that matters.
 *
 * Wrapping is the fix, and the reason it has to be a wrapper rather than a
 * bound function is that tests replace the global after this module is loaded.
 */
const defaultTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function createWorkspacePersistence({
  sessions,
  store,
  boot,
  now = () => Date.now(),
  timers = defaultTimers,
  debounceMs = SAVE_DEBOUNCE_MS,
  onPersistenceFailure = null,
  report = formatWorkspaceReport,
}) {
  const persistenceMode = ref(
    store.hasNativeWorkspaceStore() ? 'native' : 'local',
  );
  const workspaceReport = ref(null);
  let saveTimer = 0;

  function refreshReport() {
    workspaceReport.value = report(store.getWorkspaceReport());
  }

  /*
   * Dismisses the header pill and the module-level report behind it (see
   * TODO-066). Clearing only the local ref left the workspace.js report in
   * place, so the next debounced persist() refreshed it back into view.
   */
  function dismissReport() {
    if (typeof store.clearWorkspaceReport === 'function') {
      store.clearWorkspaceReport();
    }
    refreshReport();
  }

  /* Snapshot of everything worth restoring after a restart. */
  function snapshot() {
    return {
      view: sessions.view.value,
      tocItems: sessions.tocItems.value,
      activeTocId: sessions.activeTocId.value,
      editor: { content: sessions.editorContent.value },
      pdf: {
        name: sessions.pdfName.value,
        path: sessions.pdfPath.value,
        recentPaths: sessions.pdfRecentPaths.value,
        size: sessions.pdfSessionSize.value,
        url: sessions.pdfSourceUrl.value,
        documentId: sessions.pdfDocumentId.value,
        page: sessions.pdfPageNumber.value,
        zoom: sessions.pdfZoom.value,
        workspaceDirectory: sessions.workspaceDirectory?.value ?? '',
      },
      images: {
        directoryName: sessions.imageDirectoryName.value,
        directoryPath: sessions.imageDirectoryPath.value,
        recentPaths: sessions.imageRecentPaths.value,
        selectedGroup: sessions.selectedImageGroup.value,
      },
      map: {
        places: sessions.mapPlaces ? sessions.mapPlaces() : [],
        sidebarOpen: sessions.mapSidebarOpen?.value ?? true,
        filter: sessions.mapFilter?.value ?? 'none',
        renderer: sessions.mapRenderer?.value ?? 'dom',
        showGrid: sessions.mapShowGrid?.value ?? false,
        showCursor: sessions.mapShowCursor?.value ?? true,
      },
      /*
       * The Google viewer, as its own block rather than more fields on `map`. It
       * is a separate session with a separate set of view options, and folding
       * them together would mean a workspace could hold an Explorer filter and a
       * Google renderer under one name with nothing to say which is which.
       *
       * Guarded field by field because a workspace written before this block
       * existed has no `googleMap` at all, and the Explorer must keep restoring
       * for those.
       */
      ...(sessions.googleMapLayer
        ? {
            googleMap: {
              layer: sessions.googleMapLayer.value,
              renderer: sessions.googleMapRenderer?.value ?? 'dom',
              showGrid: Boolean(sessions.googleMapShowGrid?.value),
              showCursor: sessions.googleMapShowCursor?.value !== false,
            },
          }
        : {}),
    };
  }

  /*
   * Restores a snapshot into the session modules. Returns false when the
   * snapshot is missing, so hydration can keep the boot state.
   *
   * Only the remembered paths come back: a document or directory is re-opened
   * by picking its path, never as a side effect of loading the workspace.
   */
  function apply(incoming) {
    if (!incoming) return false;
    const activeId = incoming.tocItems.some(
      (item) => item.id === incoming.activeTocId,
    )
      ? incoming.activeTocId
      : null;
    sessions.view.value = incoming.view;
    sessions.tocItems.value = incoming.tocItems;
    sessions.activeTocId.value = activeId;
    sessions.linkTargetId.value = activeId || incoming.tocItems[0]?.id || null;
    sessions.editorContent.value = incoming.editor.content;
    sessions.pdfName.value = incoming.pdf.name || 'No document selected';
    sessions.pdfPath.value = incoming.pdf.path || '';
    sessions.pdfRecentPaths.value = [...(incoming.pdf.recentPaths ?? [])];
    sessions.pdfSessionSize.value = incoming.pdf.size;
    sessions.pdfSourceUrl.value = incoming.pdf.url;
    sessions.pdfDocumentId.value = incoming.pdf.documentId;
    sessions.pdfPageNumber.value = incoming.pdf.page;
    sessions.pdfZoom.value = incoming.pdf.zoom;
    if (sessions.workspaceDirectory) {
      sessions.workspaceDirectory.value = incoming.pdf.workspaceDirectory || '';
    }
    sessions.imageDirectoryName.value = incoming.images.directoryName;
    sessions.imageDirectoryPath.value = incoming.images.directoryPath || '';
    sessions.imageRecentPaths.value = [...(incoming.images.recentPaths ?? [])];
    sessions.selectedImageGroup.value = incoming.images.selectedGroup;

    /*
     * The map's own state. Every field is optional here because a workspace
     * written before the Explorer existed has no `map` at all, and a viewer that
     * refuses to start over that would be a poor way to add a tool.
     */
    if (sessions.applyMapPlaces) sessions.applyMapPlaces(incoming.map?.places);
    if (sessions.mapSidebarOpen)
      sessions.mapSidebarOpen.value = incoming.map?.sidebarOpen !== false;
    if (sessions.mapFilter)
      sessions.mapFilter.value = incoming.map?.filter ?? 'none';
    if (sessions.mapRenderer)
      sessions.mapRenderer.value =
        incoming.map?.renderer === 'canvas' ? 'canvas' : 'dom';
    if (sessions.mapShowGrid)
      sessions.mapShowGrid.value = Boolean(incoming.map?.showGrid);
    if (sessions.mapShowCursor)
      sessions.mapShowCursor.value = incoming.map?.showCursor !== false;

    /*
     * The Google viewer's options, same contract as the Explorer's above: every
     * field optional, because `googleMap` is absent from any workspace written
     * before this block existed and the viewer must start from its own defaults
     * rather than refuse to restore.
     *
     * The layer is validated against the closed list rather than passed through.
     * An unrecognized name would produce a tile URL the session has no styling or
     * badge for, which is the same failure mode the Explorer filter list closes
     * against.
     */
    if (sessions.googleMapLayer) {
      const stored = incoming.googleMap?.layer;
      sessions.googleMapLayer.value = GOOGLE_MAP_LAYERS.includes(stored)
        ? stored
        : 'm';
      if (sessions.googleMapRenderer)
        sessions.googleMapRenderer.value =
          incoming.googleMap?.renderer === 'canvas' ? 'canvas' : 'dom';
      if (sessions.googleMapShowGrid)
        sessions.googleMapShowGrid.value = Boolean(
          incoming.googleMap?.showGrid,
        );
      if (sessions.googleMapShowCursor)
        sessions.googleMapShowCursor.value =
          incoming.googleMap?.showCursor !== false;
    }
    return true;
  }

  /*
   * Writes the snapshot to localStorage first (the synchronous boot cache) and
   * then, when the host provides it, to the durable store.
   *
   * Returns the local result. A native failure with a working local cache is a
   * degraded mode, not a lost workspace, so it only reaches the caller as a
   * mode change and the header report; when neither store accepted the write
   * the failure is escalated through onPersistenceFailure.
   */
  function persist() {
    const state = { ...snapshot(), savedAt: now() };
    const serialized = store.serializeWorkspace(state);
    const savedLocally = store.saveWorkspace(state);
    if (!store.hasNativeWorkspaceStore()) {
      persistenceMode.value = savedLocally ? 'local' : 'none';
      refreshReport();
      return savedLocally;
    }

    store.saveWorkspaceNative(serialized).then((savedNatively) => {
      if (savedNatively) {
        persistenceMode.value = 'native';
        refreshReport();
        return;
      }
      persistenceMode.value = savedLocally ? 'local' : 'none';
      refreshReport();
      if (!savedLocally && onPersistenceFailure)
        onPersistenceFailure(SAVE_FAILURE_MESSAGE);
    });
    return savedLocally;
  }

  function flush() {
    if (saveTimer) {
      timers.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    return persist();
  }

  /* Coalesces bursts of edits into one write. */
  function schedule() {
    if (saveTimer) timers.clearTimeout(saveTimer);
    saveTimer = timers.setTimeout(flush, debounceMs);
  }

  /*
   * Loads the durable copy once at startup. The native copy wins unless the
   * boot snapshot is newer, and never after the user has already acted.
   */
  async function hydrate() {
    if (!store.hasNativeWorkspaceStore() || store.hasUserInteracted())
      return false;
    const restored = await store.loadWorkspaceNative();
    refreshReport();
    if (!restored || store.hasUserInteracted()) return false;
    const bootSavedAt = boot?.savedAt ?? 0;
    if (restored.savedAt < bootSavedAt) return false;
    return apply(restored);
  }

  refreshReport();

  return {
    /* 'native' | 'local' | 'none' — which store accepted the last write. */
    persistenceMode: computed(() => persistenceMode.value),
    workspaceReport,
    snapshot,
    apply,
    persist,
    flush,
    schedule,
    hydrate,
    refreshReport,
    dismissReport,
  };
}

export { SAVE_DEBOUNCE_MS, SAVE_FAILURE_MESSAGE };

/*
 * The human phrase for a persistence mode.
 *
 * A pure function of the mode rather than a computed inside the engine, because
 * both the shell (for a tool's badge) and the editor's status bar want the same
 * sentence, and the engine is a per-instance object neither of them should have to
 * reach into. Three inputs, three answers, and it can be tested without an engine.
 */
export function saveLabelFor(mode) {
  if (mode === 'native') return 'saved to disk';
  if (mode === 'local') return 'auto-saved';
  return 'not saved';
}

/*
 * The app's single persistence engine, for callers outside App.vue.
 *
 * A pane that changes workspace state - the folder the combined PDF goes to, say -
 * needs to ask for a save, and that save is owned by the engine instance App.vue
 * builds. Threading the engine through as a prop would make every pane depend on
 * the shell's construction; this delegate is the same singleton pattern every
 * other session module already uses, and it is registered once at boot.
 *
 * A no-op before registration rather than a throw: `persistNow` in toc-outline.js
 * already behaves this way, and a pane mounted before the engine exists has
 * nothing to save anyway.
 */
let engine = null;

export function registerWorkspacePersistence(instance) {
  engine = instance;
}

export function scheduleWorkspaceSave() {
  engine?.schedule();
}
