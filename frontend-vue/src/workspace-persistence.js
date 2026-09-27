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
import { formatWorkspaceReport } from './workspace-report.js';

const SAVE_DEBOUNCE_MS = 250;

const SAVE_FAILURE_MESSAGE = 'The workspace could not be saved to this device.';

/*
 * sessions: the refs the four tools own (see App.vue's import list).
 * store:   workspace.js's persistence surface.
 * boot:    the boot snapshot from boot-state.js.
 */
export function createWorkspacePersistence({
  sessions,
  store,
  boot,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
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
  };
}

export { SAVE_DEBOUNCE_MS, SAVE_FAILURE_MESSAGE };
