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
  onViewEnterPdf,
  onViewLeaveEditor,
  selectView,
  view,
} from './app-shell.js';
import { restoredWorkspace } from './boot-state.js';
import {
  cursorPosition,
  editorContent,
  editorInput,
  editorWordCount,
  updateCursor,
} from './editor-session.js';
import {
  activeLightboxImage,
  changeLightbox,
  closeLightbox,
  handleLightboxKeydown,
  imageDirectoryInput,
  imageDirectoryName,
  imageFiles,
  imageGroups,
  imageLoading,
  imageStatus,
  imageStatusError,
  imagesBadge,
  loadBrowserImageDirectory,
  openImageDirectory,
  openLightbox,
  selectedImageGroup,
  setImageStatus,
  visibleImages,
} from './image-session.js';
import {
  activePage,
  changePdfPage,
  disposePdfSession,
  handlePdfFile,
  handlePdfScroll,
  navigateToPage,
  openPdf,
  pdfBadge,
  pdfContentElement,
  pdfDocument,
  pdfDocumentId,
  pdfFileInput,
  pdfLoading,
  pdfName,
  pdfPageCount,
  pdfPageNumber,
  pdfRenderError,
  pdfSessionSize,
  pdfSourceUrl,
  pdfStatus,
  pdfStatusError,
  pdfZoom,
  renderAllPdfPages,
  resumePdfSession,
  scrollToPdfPage,
  setPdfPageCanvas,
  setPdfStatus,
  tocCached,
  tocCount,
  tocHeadings,
  tocMessage,
  tocState,
} from './pdf-session.js';
import {
  activeTocId,
  activeTocIndex,
  activeTocItem,
  addTocItem,
  attachImageToToc,
  attachPdfPageToToc,
  configureTocOutline,
  importPdfHeadingsToToc,
  linkTarget,
  linkTargetId,
  nextTocItem,
  openLinkedImages,
  openLinkedPdfPage,
  previousTocItem,
  removeTocItem,
  selectTocItem,
  syncTocDraft,
  tocDraftLevel,
  tocDraftTitle,
  tocItemLabel,
  tocItems,
  tocStatus,
  tocStatusError,
} from './toc-outline.js';
import {
  countWords,
  getWorkspaceReport,
  hasNativeWorkspaceStore,
  loadWorkspaceNative,
  outlineSummary,
  saveWorkspace,
  saveWorkspaceNative,
  serializeWorkspace,
} from './workspace.js';
import { formatWorkspaceReport } from './workspace-report.js';

/*
 * Composition layer.
 *
 * The four tools own their own state and behaviour in src/*-session.js,
 * src/toc-outline.js, and src/app-shell.js; this file wires them together,
 * owns cross-tool labels, and runs the persistence loop: snapshot, debounce,
 * native write, restore, and the header report when either direction fails.
 */

/* --- cross-tool labels ---------------------------------------------------- */

const documentTitle = computed(() =>
  activeTocItem.value ? activeTocItem.value.title : 'untitled.txt',
);

const outlineSummaryState = computed(() => outlineSummary(tocItems.value));

const outlineBadge = computed(() => {
  const { total, written } = outlineSummaryState.value;
  if (total === 0) return 'Declare outline items, then write each section';
  return `${total} item${total === 1 ? '' : 's'} declared · ${written} written`;
});

const editorBadge = computed(() => {
  if (activeTocItem.value) {
    return `Writing “${activeTocItem.value.title}” · ${editorWordCount.value} words`;
  }
  if (editorWordCount.value > 0) {
    return `${editorWordCount.value} words in an untitled draft`;
  }
  return 'Write each section of your outline';
});

const saveLabel = computed(() => {
  if (persistenceMode.value === 'native') return 'saved to disk';
  if (persistenceMode.value === 'local') return 'auto-saved';
  return 'not saved';
});

const documentStatus = computed(() => {
  const words =
    editorWordCount.value === 0
      ? 'Empty document'
      : `${editorWordCount.value} word${editorWordCount.value === 1 ? '' : 's'}`;
  if (activeTocIndex.value < 0) {
    return tocItems.value.length > 0
      ? `${words} · pick a section in Outline`
      : `${words} · declare a section to start writing`;
  }
  return [
    `Item ${activeTocIndex.value + 1} of ${tocItems.value.length}`,
    words,
    saveLabel.value,
  ].join(' · ');
});

/* --- view transitions ----------------------------------------------------- */

/* Leaving the editor flushes the draft; entering the PDF resumes its session. */
onViewLeaveEditor(() => syncTocDraft());
onViewEnterPdf(() => {
  if (!pdfDocument.value && pdfSourceUrl.value) resumePdfSession();
});

/* --- workspace persistence ------------------------------------------------ */

const persistenceMode = ref(hasNativeWorkspaceStore() ? 'native' : 'local');
const workspaceReport = ref(null);

/*
 * Mirrors the latest persistence failure from workspace.js into a sentence the
 * header can show. The report clears once the underlying problem is resolved.
 */
function refreshWorkspaceReport() {
  workspaceReport.value = formatWorkspaceReport(getWorkspaceReport());
}

refreshWorkspaceReport();

/* Snapshot of everything worth restoring after a restart. */
function workspaceState() {
  return {
    view: view.value,
    tocItems: tocItems.value,
    activeTocId: activeTocId.value,
    editor: { content: editorContent.value },
    pdf: {
      name: pdfName.value,
      size: pdfSessionSize.value,
      url: pdfSourceUrl.value,
      documentId: pdfDocumentId.value,
      page: pdfPageNumber.value,
      zoom: pdfZoom.value,
    },
    images: {
      directoryName: imageDirectoryName.value,
      selectedGroup: selectedImageGroup.value,
    },
  };
}

let workspaceSaveTimer = 0;

/*
 * Writes the snapshot to localStorage first (synchronous boot cache) and then,
 * when the host provides it, to the durable store. Failures are reported
 * through the header pill rather than only the TOC status.
 */
function persistWorkspace() {
  const state = { ...workspaceState(), savedAt: Date.now() };
  const serialized = serializeWorkspace(state);
  const savedLocally = saveWorkspace(state);
  if (!hasNativeWorkspaceStore()) {
    persistenceMode.value = savedLocally ? 'local' : 'none';
    refreshWorkspaceReport();
    return savedLocally;
  }
  saveWorkspaceNative(serialized).then((savedNatively) => {
    if (savedNatively) {
      persistenceMode.value = 'native';
      refreshWorkspaceReport();
      return;
    }
    persistenceMode.value = savedLocally ? 'local' : 'none';
    refreshWorkspaceReport();
    if (!savedLocally) {
      tocStatusError.value = true;
      tocStatus.value = 'The workspace could not be saved to this device.';
    }
  });
  // The native write finishes later; failures surface through the header
  // report, persistenceMode, and the TOC status rather than this return value.
  return true;
}

function flushWorkspace() {
  if (workspaceSaveTimer) {
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = 0;
  }
  return persistWorkspace();
}

function scheduleWorkspaceSave() {
  if (workspaceSaveTimer) clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(flushWorkspace, 250);
}

/* The outline writes through this hook so it never imports this file back. */
configureTocOutline({ persistNow: () => persistWorkspace() });

/*
 * Restores a snapshot into the session modules. Returns false when the
 * snapshot is missing, so hydration can keep the boot state.
 */
function applyWorkspace(snapshot) {
  if (!snapshot) return false;
  const activeId = snapshot.tocItems.some(
    (item) => item.id === snapshot.activeTocId,
  )
    ? snapshot.activeTocId
    : null;
  view.value = snapshot.view;
  tocItems.value = snapshot.tocItems;
  activeTocId.value = activeId;
  linkTargetId.value = activeId || snapshot.tocItems[0]?.id || null;
  editorContent.value = snapshot.editor.content;
  pdfName.value = snapshot.pdf.name || 'No document selected';
  pdfSessionSize.value = snapshot.pdf.size;
  pdfSourceUrl.value = snapshot.pdf.url;
  pdfDocumentId.value = snapshot.pdf.documentId;
  pdfPageNumber.value = snapshot.pdf.page;
  pdfZoom.value = snapshot.pdf.zoom;
  imageDirectoryName.value = snapshot.images.directoryName;
  selectedImageGroup.value = snapshot.images.selectedGroup;
  return true;
}

/* Loads the durable copy once at startup, unless the user already acted. */
async function hydrateNativeWorkspace() {
  if (!hasNativeWorkspaceStore() || hasUserInteracted()) return false;
  const snapshot = await loadWorkspaceNative();
  refreshWorkspaceReport();
  if (!snapshot || hasUserInteracted()) return false;
  if (snapshot.savedAt < restoredWorkspace.savedAt) return false;
  return applyWorkspace(snapshot);
}

/* --- watchers -------------------------------------------------------------- */

watch(
  [
    view,
    editorContent,
    tocItems,
    activeTocId,
    pdfName,
    pdfSessionSize,
    pdfSourceUrl,
    pdfDocumentId,
    pdfPageNumber,
    pdfZoom,
    imageDirectoryName,
    selectedImageGroup,
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
  const savedLocally = saveWorkspace({
    ...workspaceState(),
    savedAt: Date.now(),
  });
  if (hasNativeWorkspaceStore()) {
    persistenceMode.value = 'native';
    await hydrateNativeWorkspace();
  } else {
    persistenceMode.value = savedLocally ? 'local' : 'none';
    refreshWorkspaceReport();
  }

  if (view.value === 'pdf' && pdfSourceUrl.value) resumePdfSession();
  if (
    view.value === 'images' &&
    imageDirectoryName.value &&
    imageFiles.value.length === 0
  ) {
    setImageStatus(
      `${imageDirectoryName.value}: select the folder again to reload its images.`,
    );
  }
  if (view.value === 'editor') {
    nextTick(() => editorInput.value?.focus());
  }
});

window.addEventListener('pagehide', flushWorkspace);
window.addEventListener('beforeunload', flushWorkspace);
document.addEventListener('visibilitychange', handleVisibilityChange);

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flushWorkspace);
  window.removeEventListener('beforeunload', flushWorkspace);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  flushWorkspace();
  disposePdfSession();
});
</script>

<template>
  <main class="app-shell" :class="{ 'pdf-active': view === 'pdf', 'image-active': view === 'images' }">
    <header class="launcher-header">
      <div class="brand">
        <span class="brand-mark">N</span>
        <div>
          <span class="brand-name">Native Workspace</span>
          <span class="brand-subtitle">Local tools, one workspace</span>
        </div>
      </div>
      <div class="header-status">
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
          @click="workspaceReport = null"
        >×</button>
        <button class="toolbar-button subtle" id="back-to-menu" type="button" @click="selectView('menu')">
          All apps
        </button>
      </div>
    </header>

    <section v-show="view === 'menu'" class="app-menu" data-view="menu" aria-label="Application menu">
      <div class="menu-heading">
        <span>APPLICATIONS</span>
        <h1>What would you like to open?</h1>
        <p>Choose a local tool to get started.</p>
      </div>
      <div class="app-grid">
        <button class="app-card" data-app="editor" type="button" @click="selectView('editor')">
          <span class="app-icon text-icon" aria-hidden="true">Aa</span>
          <span class="app-card-copy">
            <strong>Text Editor</strong>
            <small :title="editorBadge">{{ editorBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="pdf" type="button" @click="selectView('pdf')">
          <span class="app-icon pdf-icon" aria-hidden="true">PDF</span>
          <span class="app-card-copy">
            <strong>PDF Reader</strong>
            <small :title="pdfBadge">{{ pdfBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="images" type="button" @click="selectView('images')">
          <span class="app-icon image-icon" aria-hidden="true">IMG</span>
          <span class="app-card-copy">
            <strong>Image Viewer</strong>
            <small :title="imagesBadge">{{ imagesBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="toc" type="button" @click="selectView('toc')">
          <span class="app-icon toc-manager-icon" aria-hidden="true">TOC</span>
          <span class="app-card-copy">
            <strong>TOC Manager</strong>
            <small :title="outlineBadge">{{ outlineBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
      </div>
    </section>

    <section v-show="view === 'toc'" class="toc-manager" data-view="toc" aria-label="TOC manager application">
      <header class="toc-manager-toolbar">
        <div>
          <span class="toc-manager-eyebrow">TOC MANAGER</span>
          <strong id="toc-manager-count">{{ tocItemLabel }}</strong>
        </div>
        <div class="toc-manager-actions">
          <span id="toc-manager-status" class="toc-manager-status" :class="{ error: tocStatusError }" :title="tocStatus" aria-live="polite">{{ tocStatus }}</span>
          <button class="toolbar-button subtle" id="resume-writing" type="button" :disabled="!activeTocId" @click="selectView('editor')">Resume writing</button>
        </div>
      </header>

      <div class="toc-manager-body">
        <form class="toc-declare" @submit.prevent="addTocItem">
          <div class="toc-declare-heading">
            <span>DECLARE</span>
            <strong>New outline item</strong>
          </div>
          <label for="toc-title-input">Heading title</label>
          <input
            id="toc-title-input"
            v-model="tocDraftTitle"
            type="text"
            maxlength="120"
            autocomplete="off"
            placeholder="Chapter 1 · Introduction"
          />
          <label for="toc-level-input">Level</label>
          <select id="toc-level-input" v-model="tocDraftLevel">
            <option :value="1">Level 1 · Chapter</option>
            <option :value="2">Level 2 · Section</option>
            <option :value="3">Level 3 · Subsection</option>
          </select>
          <button class="toolbar-button primary" type="submit">Declare item</button>
          <p class="toc-declare-hint">
            Selecting an item opens it in the Text Editor. Every draft is stored per item in this
            browser.
          </p>
        </form>

        <div class="toc-outline">
          <div class="toc-outline-heading">
            <span>DECLARED ITEMS</span>
            <span>Select an item to write</span>
          </div>
          <ul v-if="tocItems.length" class="toc-outline-list">
            <li
              v-for="item in tocItems"
              :key="item.id"
              class="toc-outline-item"
              :class="{ active: activeTocId === item.id }"
              :style="{ '--toc-level': item.level }"
            >
              <button class="toc-outline-select" type="button" @click="selectTocItem(item)">
                <span class="toc-outline-title">{{ item.title }}</span>
                <small>{{ countWords(item.content) }} word{{ countWords(item.content) === 1 ? '' : 's' }} · {{ item.content ? 'draft saved' : 'no draft yet' }}</small>
              </button>
              <div class="toc-outline-meta">
                <span class="toc-outline-level">H{{ item.level }}</span>
                <button v-if="item.links.pdfPage" class="toc-outline-link" type="button" :title="`Open ${item.links.pdfName || 'the PDF'} at page ${item.links.pdfPage}`" @click="openLinkedPdfPage(item)">p.{{ item.links.pdfPage }}</button>
                <button v-if="item.links.images.length" class="toc-outline-link" type="button" :title="`${item.links.images.length} attached image(s)`" @click="openLinkedImages(item)">IMG {{ item.links.images.length }}</button>
                <button class="toc-outline-remove" type="button" :aria-label="`Remove ${item.title}`" @click="removeTocItem(item)">×</button>
              </div>
            </li>
          </ul>
          <div v-else class="toc-outline-empty">
            <span class="toc-outline-empty-icon" aria-hidden="true">TOC</span>
            <h2>No outline items yet</h2>
            <p>Declare your first heading, then select it to start writing that section in the Text Editor.</p>
          </div>
        </div>
      </div>
    </section>

    <section v-show="view === 'editor'" class="editor-app" data-view="editor" aria-label="Text editor application">
      <header class="topbar">
        <div class="topbar-side">
          <button class="toolbar-button subtle" id="back-to-outline" type="button" @click="selectView('toc')">‹ Outline</button>
        </div>
        <div class="document-title" aria-live="polite">
          <span v-if="activeTocItem" class="document-level">H{{ activeTocItem.level }}</span>
          <span id="document-title-text">{{ documentTitle }}</span>
        </div>
        <div class="top-actions">
          <button v-if="activeTocItem?.links?.pdfPage" class="toolbar-button subtle" id="open-linked-pdf" type="button" @click="openLinkedPdfPage(activeTocItem)">PDF p.{{ activeTocItem.links.pdfPage }}</button>
          <button v-if="activeTocItem" class="toolbar-button subtle" id="previous-outline-item" type="button" :disabled="!previousTocItem" @click="previousTocItem && selectTocItem(previousTocItem)">‹ Prev</button>
          <button v-if="activeTocItem" class="toolbar-button subtle" id="next-outline-item" type="button" :disabled="!nextTocItem" @click="nextTocItem && selectTocItem(nextTocItem)">Next ›</button>
        </div>
      </header>

      <div class="editor-pane">
        <label class="sr-only" for="values">Document text</label>
        <textarea
          id="values"
          ref="editorInput"
          :value="editorContent"
          spellcheck="true"
          placeholder="Start writing…"
          aria-describedby="document-status"
          @input="editorContent = $event.target.value; updateCursor(); syncTocDraft()"
          @click="updateCursor"
          @keyup="updateCursor"
        />
        <div class="editor-footer">
          <span id="document-status">{{ documentStatus }}</span>
          <span id="cursor-position">{{ cursorPosition }}</span>
        </div>
      </div>
    </section>

    <section v-show="view === 'images'" class="image-app" data-view="images" aria-label="Image viewer application">
      <header class="image-toolbar">
        <div>
          <span class="image-eyebrow">IMAGE VIEWER</span>
          <strong>{{ imageDirectoryName || 'Choose an image directory' }}</strong>
        </div>
        <div class="image-actions">
          <span id="image-status" class="image-status" :class="{ error: imageStatusError }" :title="imageStatus" aria-live="polite">{{ imageStatus }}</span>
          <button v-show="imageFiles.length > 0" class="toolbar-button primary" id="open-image-directory" type="button" :disabled="imageLoading" @click="openImageDirectory">Choose directory</button>
        </div>
      </header>
      <aside class="image-sidebar" aria-label="Image folders">
        <div class="image-sidebar-heading">FOLDERS</div>
        <button
          v-for="group in imageGroups"
          :key="group.name"
          class="image-group-button"
          :class="{ active: selectedImageGroup === group.name }"
          :title="group.name"
          type="button"
          @click="selectedImageGroup = group.name; closeLightbox()"
        >
          <span>{{ group.name }}</span><small>{{ group.images.length }}</small>
        </button>
      </aside>
      <div class="image-content">
        <input
          id="image-directory-input"
          ref="imageDirectoryInput"
          class="sr-only"
          type="file"
          webkitdirectory
          multiple
          accept="image/*,.avif,.heic,.heif,.svg,.tif,.tiff"
          @change="loadBrowserImageDirectory"
        />
        <div v-if="!imageFiles.length" class="image-empty">
          <span class="image-large-icon" aria-hidden="true">IMG</span>
          <h2>Browse a folder of images</h2>
          <p>Select a parent directory. Inner folders become categories in the sidebar.</p>
          <button class="toolbar-button primary" id="browse-image-directory" type="button" @click="openImageDirectory">Choose directory</button>
        </div>
        <div v-else class="image-grid" aria-label="Image thumbnails">
          <button v-for="image in visibleImages" :key="image.relativePath" class="image-thumbnail" type="button" @click="openLightbox(image)">
            <img :src="image.dataUrl" :alt="image.name" loading="lazy" />
            <span :title="image.relativePath">{{ image.name }}</span>
          </button>
        </div>
      </div>
    </section>

    <section v-show="view === 'pdf'" class="pdf-app" data-view="pdf" aria-label="PDF reader application">
      <header class="pdf-toolbar">
        <div>
          <span class="pdf-eyebrow">PDF READER</span>
          <strong id="pdf-name">{{ pdfName }}</strong>
        </div>
        <div class="pdf-actions">
          <span id="pdf-status" class="pdf-status" :class="{ error: pdfStatusError }" :title="pdfStatus" aria-live="polite">{{ pdfStatus }}</span>
          <button v-show="pdfDocument" class="toolbar-button primary" id="open-pdf" type="button" @click="openPdf">Open PDF</button>
        </div>
      </header>
      <aside class="toc-sidebar" aria-label="Document table of contents">
        <div class="toc-heading">
          <span>CONTENTS</span>
          <strong id="toc-count">{{ tocCount }}</strong>
        </div>
        <nav id="toc-panel" class="toc-panel" :data-state="tocState" aria-live="polite">
          <p v-if="tocState !== 'ready'" class="toc-message">{{ tocMessage }}</p>
          <button
            v-for="heading in tocHeadings"
            :key="`${heading.page}-${heading.position}-${heading.title}`"
            class="toc-item"
            :class="{ active: activePage === heading.page }"
            type="button"
            :data-page="heading.page"
            :style="{ '--toc-level': Math.max(1, Math.min(Number(heading.level) || 1, 3)) }"
            :title="`Page ${heading.page}${tocCached ? ' · saved TOC' : ''}`"
            @click="navigateToPage(heading.page)"
          >{{ heading.title }}</button>
        </nav>
        <div class="toc-link-panel">
          <span class="toc-link-title">OUTLINE LINK</span>
          <label class="sr-only" for="link-target-select">Outline item</label>
          <select id="link-target-select" v-model="linkTargetId">
            <option :value="null" disabled>Select outline item</option>
            <option v-for="item in tocItems" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
          <button class="toolbar-button subtle" type="button" :disabled="!linkTarget || !pdfDocument" @click="attachPdfPageToToc">Attach page {{ pdfPageNumber }}</button>
          <button class="toolbar-button subtle" type="button" :disabled="!tocHeadings.length" @click="importPdfHeadingsToToc">Import {{ tocHeadings.length }} heading{{ tocHeadings.length === 1 ? '' : 's' }}</button>
        </div>
      </aside>
      <div ref="pdfContentElement" class="pdf-content" @scroll.passive="handlePdfScroll">
        <input id="pdf-file-input" ref="pdfFileInput" class="sr-only" type="file" accept="application/pdf,.pdf" @change="handlePdfFile" />
        <div v-show="!pdfDocument" class="pdf-empty" id="pdf-empty">
          <span class="pdf-large-icon" aria-hidden="true">PDF</span>
          <h2>Read a local PDF</h2>
          <p>Use the system file picker to securely open a document from this computer.</p>
          <p v-if="pdfName !== 'No document selected'" class="pdf-resume">Last session: {{ pdfName }} · page {{ pdfPageNumber }} · {{ Math.round(pdfZoom * 100) }}%</p>
          <button v-if="pdfName !== 'No document selected'" class="toolbar-button subtle" id="resume-pdf" type="button" @click="pdfSourceUrl ? resumePdfSession() : openPdf()">Resume session</button>
          <button class="toolbar-button primary" id="browse-pdf" type="button" @click="openPdf">Browse files</button>
        </div>
        <div v-show="pdfDocument" class="pdf-rendered" aria-label="Selected PDF document">
          <div class="pdf-page-controls">
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber <= 1" @click="changePdfPage(-1)">Previous</button>
            <span>Page {{ pdfPageNumber }} of {{ pdfPageCount }}</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber >= pdfPageCount" @click="changePdfPage(1)">Next</button>
            <span class="pdf-zoom-label">Zoom</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="pdfZoom = Math.max(0.6, pdfZoom - 0.1); renderAllPdfPages()">−</button>
            <span>{{ Math.round(pdfZoom * 100) }}%</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="pdfZoom = Math.min(2.5, pdfZoom + 0.1); renderAllPdfPages()">+</button>
          </div>
          <div v-if="pdfRenderError" class="pdf-render-state error">{{ pdfRenderError }}</div>
          <div v-if="pdfLoading" class="pdf-render-state">Rendering all pages…</div>
          <div class="pdf-pages">
            <div v-for="pageNumber in pdfPageCount" :key="pageNumber" class="pdf-page">
              <canvas :ref="(element) => setPdfPageCanvas(element, pageNumber)" class="pdf-canvas" :aria-label="`Rendered PDF page ${pageNumber}`"></canvas>
            </div>
          </div>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="activeLightboxImage"
        class="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        tabindex="-1"
        @click.self="closeLightbox"
        @keydown="handleLightboxKeydown"
      >
        <button class="lightbox-close" type="button" aria-label="Close preview" @click="closeLightbox">×</button>
        <button class="lightbox-nav previous" type="button" aria-label="Previous image" @click="changeLightbox(-1)">‹</button>
        <figure>
          <img :src="activeLightboxImage.dataUrl" :alt="activeLightboxImage.name" />
          <figcaption>{{ activeLightboxImage.relativePath }}</figcaption>
          <div class="lightbox-attach">
            <label class="sr-only" for="lightbox-link-target">Outline item</label>
            <select id="lightbox-link-target" v-model="linkTargetId">
              <option :value="null" disabled>Select outline item</option>
              <option v-for="item in tocItems" :key="item.id" :value="item.id">{{ item.title }}</option>
            </select>
            <button class="toolbar-button primary" type="button" :disabled="!linkTarget" @click="attachImageToToc(activeLightboxImage)">Attach to section</button>
          </div>
        </figure>
        <button class="lightbox-nav next" type="button" aria-label="Next image" @click="changeLightbox(1)">›</button>
      </div>
    </Teleport>
  </main>
</template>

