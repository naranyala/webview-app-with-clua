<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';

import {
  hasUserInteracted,
  onViewLeaveEditor,
  selectView,
  view,
} from './app-shell.js';
import { restoredWorkspace } from './boot-state.js';
import EditorPane from './components/EditorPane.vue';
import GoogleMapPane from './components/GoogleMapPane.vue';
import ImagesPane from './components/ImagesPane.vue';
import LightboxDialog from './components/LightboxDialog.vue';
import MapPane from './components/MapPane.vue';
import MenuView from './components/MenuView.vue';
import PdfPane from './components/PdfPane.vue';
import StatusLine from './components/StatusLine.vue';
import TocPane from './components/TocPane.vue';
import {
  editorContent,
  editorInput,
  editorWordCount,
} from './editor-session.js';

import {
  disposeGoogleMapsViewer,
  googleMapBadge,
  googleMapLayer,
  googleMapRenderer,
  googleMapShowCursor,
  googleMapShowGrid,
  measureGoogleMap,
  startGoogleMapObserver,
} from './google-maps-session.js';
import {
  imageDirectoryName,
  imageDirectoryPath,
  imageFiles,
  imageRecentPaths,
  imagesBadge,
  selectedImageGroup,
  setImageStatus,
} from './image-session.js';
import {
  disposeMapExplorer,
  handleWindowResize,
  mapBadge,
  mapFilter,
  mapRenderer,
  mapShowCursor,
  mapShowGrid,
  mapSidebarOpen,
  measureMap,
  startMapObserver,
} from './map-explorer.js';

import { applyMapPlaces, mapPlacesSnapshot, places } from './map-places.js';

import { workspaceDirectory } from './outline-pdf.js';
import {
  disposePdfSession,
  pdfBadge,
  pdfDocument,
  pdfDocumentId,
  pdfLoading,
  pdfName,
  pdfPageNumber,
  pdfPath,
  pdfRecentPaths,
  pdfSessionSize,
  pdfSourceUrl,
  pdfZoom,
  renderAllPdfPages,
  scrollToPdfPage,
  setPdfStatus,
} from './pdf-session.js';
import {
  activeTocId,
  activeTocItem,
  configureTocOutline,
  linkTargetId,
  syncTocDraft,
  tocItems,
  tocStatus,
  tocStatusError,
} from './toc-outline.js';
import {
  clearWorkspaceReport,
  getWorkspaceReport,
  hasNativeWorkspaceStore,
  loadWorkspaceNative,
  outlineSummary,
  plural,
  saveWorkspace,
  saveWorkspaceNative,
  serializeWorkspace,
} from './workspace.js';
import {
  createWorkspacePersistence,
  registerWorkspacePersistence,
} from './workspace-persistence.js';

const outlineSummaryState = computed(() => outlineSummary(tocItems.value));

const outlineBadge = computed(() => {
  const { total, written } = outlineSummaryState.value;
  if (total === 0) return 'Declare outline items, then write each section';
  return `${total} ${plural(total, 'item')} declared · ${written} written`;
});

const editorBadge = computed(() => {
  if (activeTocItem.value) {
    return `Writing “${activeTocItem.value.title}” · ${editorWordCount.value} words`;
  }
  if (editorWordCount.value > 0) {
    return `${editorWordCount.value} words in an unpicked draft`;
  }
  return 'Pick a section to start writing';
});

/*
 * Leaving the editor flushes the draft. Nothing is restored when the reader is
 * entered: a document only re-opens when its path is picked from the history
 * list, so the pane comes back exactly as it was left.
 */
onViewLeaveEditor(() => syncTocDraft());

/* --- workspace persistence ------------------------------------------------ */

/*
 * The engine itself lives in workspace-persistence.js with injected sessions,
 * store, and timers, so the write order, the debounce, and the boot/native
 * reconciliation are unit tested instead of living in this component. What is
 * left here is wiring plus the one policy decision it cannot make alone: a
 * workspace that could not be written anywhere is also a TOC-level problem.
 */
const persistence = createWorkspacePersistence({
  sessions: {
    view,
    tocItems,
    activeTocId,
    linkTargetId,
    editorContent,
    pdfName,
    pdfPath,
    pdfRecentPaths,
    pdfSessionSize,
    pdfSourceUrl,
    pdfDocumentId,
    pdfPageNumber,
    pdfZoom,
    imageDirectoryName,
    imageDirectoryPath,
    imageRecentPaths,
    selectedImageGroup,
    workspaceDirectory,
    mapPlaces: mapPlacesSnapshot,
    applyMapPlaces,
    mapSidebarOpen,
    mapFilter,
    mapRenderer,
    mapShowGrid,
    mapShowCursor,
    googleMapLayer,
    googleMapRenderer,
    googleMapShowGrid,
    googleMapShowCursor,
  },
  store: {
    serializeWorkspace,
    saveWorkspace,
    hasNativeWorkspaceStore,
    loadWorkspaceNative,
    saveWorkspaceNative,
    getWorkspaceReport,
    clearWorkspaceReport,
    hasUserInteracted,
  },
  boot: restoredWorkspace,
  onPersistenceFailure(message) {
    tocStatusError.value = true;
    tocStatus.value = message;
  },
});

const {
  persistenceMode,
  workspaceReport,
  snapshot,
  apply: applyWorkspace,
  persist: persistWorkspace,
  flush: flushWorkspace,
  schedule: scheduleWorkspaceSave,
  hydrate: hydrateNativeWorkspace,
  dismissReport: dismissWorkspaceReport,
} = persistence;

/*
 * Register the engine so a pane outside this file can ask for a save without the
 * shell threading it through as a prop. See registerWorkspacePersistence.
 */
registerWorkspacePersistence(persistence);

/* The outline writes through this hook so it never imports this file back. */
configureTocOutline({ persistNow: () => persistWorkspace() });

/* --- watchers -------------------------------------------------------------- */

watch(
  [
    view,
    editorContent,
    tocItems,
    activeTocId,
    pdfName,
    pdfPath,
    pdfRecentPaths,
    pdfSessionSize,
    pdfSourceUrl,
    pdfDocumentId,
    pdfPageNumber,
    pdfZoom,
    imageDirectoryName,
    imageDirectoryPath,
    imageRecentPaths,
    selectedImageGroup,
    /* The folder the combined-outline PDF is written to. */
    workspaceDirectory,
    /*
     * The Explorer's state. Every one of these is persisted, and a ref that is
     * not in this list never reaches disk: the persistence engine is driven
     * entirely by this watcher, so a saved place would exist until the next
     * save for some unrelated reason swept it up.
     */
    places,
    mapSidebarOpen,
    mapFilter,
    mapRenderer,
    mapShowGrid,
    mapShowCursor,
    /*
     * The Google viewer's view options. These were passed into the persistence
     * engine as sessions but left out of this list, which is the same bug in the
     * other direction: they were in the snapshot path and not in the watcher that
     * triggers it, so a layer change was never written. The comment above is the
     * contract - a ref absent from this list does not reach disk.
     */
    googleMapLayer,
    googleMapRenderer,
    googleMapShowGrid,
    googleMapShowCursor,
  ],
  scheduleWorkspaceSave,
  { deep: true },
);

watch(activeTocId, (value) => {
  if (value) linkTargetId.value = value;
});

/*
 * WebKit discards the bitmap of canvases rendered while the section was
 * hidden, so returning to the reader repaints every page and restores the
 * scroll position.
 */
watch(view, async (current, previous) => {
  if (current !== 'pdf' || previous === 'pdf' || !pdfDocument.value) return;
  await nextTick();
  if (pdfLoading.value) return;
  pdfLoading.value = true;
  try {
    await renderAllPdfPages();
  } catch (error) {
    setPdfStatus(
      error instanceof Error
        ? error.message
        : 'The PDF pages could not be redrawn.',
      true,
    );
  } finally {
    pdfLoading.value = false;
  }
  await nextTick();
  scrollToPdfPage(pdfPageNumber.value);
});

/* --- lifecycle -------------------------------------------------------------- */

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') flushWorkspace();
}

onMounted(async () => {
  await hydrateNativeWorkspace();

  /*
   * The workspace may have restored the last view, and neither viewer restores
   * content: they open empty, with the remembered paths waiting to be picked.
   */
  if (view.value === 'images' && imageFiles.value.length === 0) {
    setImageStatus(
      imageRecentPaths.value.length > 0
        ? 'Pick a remembered directory above to load its images.'
        : 'Choose a parent directory to find images.',
    );
  }
  if (
    view.value === 'pdf' &&
    !pdfDocument.value &&
    pdfRecentPaths.value.length === 0
  ) {
    setPdfStatus('Choose a PDF from your system to begin reading.');
  }
  if (view.value === 'editor') {
    nextTick(() => editorInput.value?.focus());
  }
  /* The boot workspace can restore 'map' directly, so measure on first paint. */
  if (view.value === 'map') startMapObserverAfterPaint();
  if (view.value === 'googlemap') startGoogleMapObserverAfterPaint();
});

/*
 * The map pane is hidden with v-show, so it has no measurable size until the
 * view first becomes visible - and with no size there are no tiles to place.
 * Measuring on entry is what makes the canvas fill in, and the observer started
 * here keeps it correct across later resizes.
 */
function startMapObserverAfterPaint() {
  nextTick(() => {
    startMapObserver();
    measureMap();
  });
}

watch(view, (current, previous) => {
  if (current !== 'map' || previous === 'map') return;
  startMapObserverAfterPaint();
});

function startGoogleMapObserverAfterPaint() {
  nextTick(() => {
    startGoogleMapObserver();
    measureGoogleMap();
  });
}

watch(view, (current, previous) => {
  if (current !== 'googlemap' || previous === 'googlemap') return;
  startGoogleMapObserverAfterPaint();
});

window.addEventListener('pagehide', flushWorkspace);
window.addEventListener('beforeunload', flushWorkspace);
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('resize', handleWindowResize);

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flushWorkspace);
  window.removeEventListener('beforeunload', flushWorkspace);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('resize', handleWindowResize);
  disposeMapExplorer();
  disposeGoogleMapsViewer();
  flushWorkspace();
  disposePdfSession();
});
</script>

<template>
  <main class="app-shell" :class="{ 'pdf-active': view === 'pdf', 'image-active': view === 'images' }">
    <!--
      The status bar. The toggle leads so it sits at the left edge, then the
      title on one line, then the workspace report only when there is something
      to report. It was a 72px header with a brand mark and a subtitle; both
      were static, and the bar now reads as the status line it always was.
    -->
    <header class="launcher-header">
      <div class="header-status">
        <button class="toolbar-button subtle" id="back-to-menu" type="button" @click="selectView('menu')">
          All apps
        </button>
        <span class="app-title">Native Workspace</span>
        <span
          v-if="workspaceReport"
          id="workspace-report"
          class="workspace-report"
          role="status"
          :title="workspaceReport.text"
        >{{ workspaceReport.text }}</span>
        <button
          v-if="workspaceReport"
          id="dismiss-workspace-report"
          class="workspace-report-dismiss"
          type="button"
          aria-label="Dismiss workspace report"
          @click="dismissWorkspaceReport"
        >×</button>
      </div>
    </header>

    <!--
      v-show on the wrapper keeps the four panes' DOM present for every view,
      which is what lets the WebKit repaint watcher and the smoke test find
      their anchors in a fresh boot.
    -->
    <div v-show="view === 'menu'" class="app-menu-pane">
      <MenuView
        :editor-badge="editorBadge"
        :pdf-badge="pdfBadge"
        :images-badge="imagesBadge"
        :outline-badge="outlineBadge"
        :map-badge="mapBadge"
        :google-map-badge="googleMapBadge"
        @select="selectView"
      />
    </div>

    <!--
      TocPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See TocPane.vue.
    -->
    <TocPane />
    <!--
      EditorPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See EditorPane.vue.
    -->
    <EditorPane :persistence-mode="persistenceMode" />
    <!--
      ImagesPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See ImagesPane.vue.
    -->
    <ImagesPane />
    <!--
      PdfPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See PdfPane.vue.
    -->
    <PdfPane />
    <!--
      MapPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See MapPane.vue.
    -->
    <MapPane />
    <!--
      GoogleMapPane holds this pane's markup; its state still lives in the session
      modules App.vue composes. See GoogleMapPane.vue.
    -->
    <GoogleMapPane />
  </main>
</template>

