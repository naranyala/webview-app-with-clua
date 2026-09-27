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
import LightboxDialog from './components/LightboxDialog.vue';
import MenuView from './components/MenuView.vue';
import StatusLine from './components/StatusLine.vue';
import {
  cursorPosition,
  editorContent,
  editorInput,
  editorNotice,
  editorNoticeError,
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
  lightboxIndex,
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
  cancelTocEdit,
  configureTocOutline,
  editingTocId,
  editorImportInput,
  exportActiveDraftToFile,
  exportTocToFile,
  filteredTocItems,
  handleEditorImportFile,
  handleTocImportFile,
  importActiveDraftFromFile,
  importPdfHeadingsToToc,
  importTocFromFile,
  lastRemoved,
  linkTarget,
  linkTargetId,
  moveTocItem,
  nextTocItem,
  openLinkedImages,
  openLinkedPdfPage,
  previousTocItem,
  removeTocItem,
  saveTocEdit,
  selectTocItem,
  showTocFilter,
  startTocEdit,
  syncTocDraft,
  tocDraftLevel,
  tocDraftTitle,
  tocEditLevel,
  tocEditTitle,
  tocFilterQuery,
  tocImportInput,
  tocItemLabel,
  tocItems,
  tocStatus,
  tocStatusError,
  undoTocRemoval,
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
import { createWorkspacePersistence } from './workspace-persistence.js';

/*
 * Composition layer.
 *
 * The four tools own their own state and behaviour in src/*-session.js,
 * src/toc-outline.js, and src/app-shell.js; this file wires them together,
 * owns cross-tool labels, and runs the persistence loop: snapshot, debounce,
 * native write, restore, and the header report when either direction fails.
 * The Text Editor is gated: with no picked outline section the pane shows a
 * picker instead of the textarea, so every draft belongs to a declared item.
 */

/* --- cross-tool labels ---------------------------------------------------- */

const documentTitle = computed(() =>
  activeTocItem.value ? activeTocItem.value.title : 'No section selected',
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
    return `${editorWordCount.value} words in an unpicked draft`;
  }
  return 'Pick a section to start writing';
});

const saveLabel = computed(() => {
  if (persistenceMode.value === 'native') return 'saved to disk';
  if (persistenceMode.value === 'local') return 'auto-saved';
  return 'not saved';
});

/*
 * The footer only renders once a section is picked (the gate covers the pane
 * otherwise), so the active-item form is the only reachable one.
 */
const documentStatus = computed(() => {
  const words =
    editorWordCount.value === 0
      ? 'Empty document'
      : `${editorWordCount.value} word${editorWordCount.value === 1 ? '' : 's'}`;
  return [
    `Item ${activeTocIndex.value + 1} of ${tocItems.value.length}`,
    words,
    saveLabel.value,
  ].join(' · ');
});

/* --- view transitions ----------------------------------------------------- */

/*
 * The editor gate's empty-outline action: declare flow lives only in the TOC
 * Manager, so jump there and focus the declare input.
 */
function goDeclareSection() {
  selectView('toc');
  nextTick(() => document.getElementById('toc-title-input')?.focus());
}

/* Leaving the editor flushes the draft; entering the PDF resumes its session. */
onViewLeaveEditor(() => syncTocDraft());
onViewEnterPdf(() => {
  if (!pdfDocument.value && pdfSourceUrl.value) resumePdfSession();
});

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
    pdfSessionSize,
    pdfSourceUrl,
    pdfDocumentId,
    pdfPageNumber,
    pdfZoom,
    imageDirectoryName,
    selectedImageGroup,
  },
  store: {
    serializeWorkspace,
    saveWorkspace,
    hasNativeWorkspaceStore,
    loadWorkspaceNative,
    saveWorkspaceNative,
    getWorkspaceReport,
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
} = persistence;

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
  await hydrateNativeWorkspace();

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
        @select="selectView"
      />
    </div>

    <section v-show="view === 'toc'" class="toc-manager" data-view="toc" aria-label="TOC manager application">
      <header class="toc-manager-toolbar">
        <div>
          <span class="toc-manager-eyebrow">TOC MANAGER</span>
          <strong id="toc-manager-count">{{ tocItemLabel }}</strong>
        </div>
        <div class="toc-manager-actions">
          <StatusLine
            id="toc-manager-status"
            class="toc-manager-status"
            :message="tocStatus"
            :error="tocStatusError"
          />
          <button class="toolbar-button subtle" id="toc-import-json" type="button" @click="importTocFromFile">Import…</button>
          <button class="toolbar-button subtle" id="toc-export-json" type="button" :disabled="tocItems.length === 0" @click="exportTocToFile">Export…</button>
          <button v-if="lastRemoved" class="toolbar-button subtle toc-undo" id="toc-undo-remove" type="button" @click="undoTocRemoval">Undo remove</button>
          <button class="toolbar-button subtle" id="resume-writing" type="button" :disabled="!activeTocId" @click="selectView('editor')">Resume writing</button>
        </div>
      </header>

      <input
        id="toc-import-input"
        ref="tocImportInput"
        class="sr-only"
        type="file"
        accept=".json,application/json"
        @change="handleTocImportFile"
      />

      <div class="toc-manager-body">
        <div class="toc-outline">
          <div class="toc-outline-heading">
            <span>DECLARED ITEMS</span>
            <span>Select an item to write</span>
          </div>

          <form class="toc-declare-bar" @submit.prevent="addTocItem">
            <label class="sr-only" for="toc-title-input">Heading title</label>
            <input
              id="toc-title-input"
              v-model="tocDraftTitle"
              type="text"
              maxlength="120"
              autocomplete="off"
              placeholder="New section title…"
            />
            <label class="sr-only" for="toc-level-input">Level</label>
            <select id="toc-level-input" v-model="tocDraftLevel">
              <option :value="1">H1 · Chapter</option>
              <option :value="2">H2 · Section</option>
              <option :value="3">H3 · Subsection</option>
            </select>
            <button class="toolbar-button primary" type="submit">Add section</button>
          </form>
          <p class="toc-bar-hint">
            Selecting an item opens it in the Text Editor. Every draft is stored per item in this
            browser.
          </p>

          <div v-if="showTocFilter" class="toc-filter">
            <label class="sr-only" for="toc-filter-input">Filter sections</label>
            <input
              id="toc-filter-input"
              v-model="tocFilterQuery"
              type="search"
              autocomplete="off"
              placeholder="Filter sections…"
            />
          </div>

          <ul v-if="tocItems.length && filteredTocItems.length" class="toc-outline-list">
            <li
              v-for="(item, index) in filteredTocItems"
              :key="item.id"
              class="toc-outline-item"
              :class="{ active: activeTocId === item.id }"
              :style="{ '--toc-level': item.level }"
            >
              <form v-if="editingTocId === item.id" class="toc-edit" @submit.prevent="saveTocEdit(item)">
                <label class="sr-only" for="toc-edit-input">Heading title</label>
                <input id="toc-edit-input" v-model="tocEditTitle" type="text" maxlength="120" autocomplete="off" />
                <label class="sr-only" for="toc-edit-level">Level</label>
                <select id="toc-edit-level" v-model="tocEditLevel">
                  <option :value="1">H1</option>
                  <option :value="2">H2</option>
                  <option :value="3">H3</option>
                </select>
                <button class="toolbar-button primary" type="submit">Save</button>
                <button class="toolbar-button subtle" type="button" @click="cancelTocEdit">Cancel</button>
              </form>
              <template v-else>
                <button class="toc-outline-select" type="button" @click="selectTocItem(item)">
                  <span class="toc-outline-title">{{ item.title }}</span>
                  <small>{{ countWords(item.content) }} word{{ countWords(item.content) === 1 ? '' : 's' }} · {{ item.content ? 'draft saved' : 'no draft yet' }}</small>
                </button>
                <div class="toc-outline-meta">
                  <span class="toc-outline-level">H{{ item.level }}</span>
                  <button v-if="item.links.pdfPage" class="toc-outline-link" type="button" :title="`Open ${item.links.pdfName || 'the PDF'} at page ${item.links.pdfPage}`" @click="openLinkedPdfPage(item)">p.{{ item.links.pdfPage }}</button>
                  <button v-if="item.links.images.length" class="toc-outline-link" type="button" :title="`${item.links.images.length} attached image(s)`" @click="openLinkedImages(item)">IMG {{ item.links.images.length }}</button>
                  <button
                    class="toc-outline-move"
                    type="button"
                    :disabled="Boolean(tocFilterQuery.trim()) || index === 0"
                    :title="tocFilterQuery.trim() ? 'Clear the filter to reorder' : `Move ${item.title} up`"
                    :aria-label="`Move ${item.title} up`"
                    @click="moveTocItem(item, -1)"
                  >↑</button>
                  <button
                    class="toc-outline-move"
                    type="button"
                    :disabled="Boolean(tocFilterQuery.trim()) || index === filteredTocItems.length - 1"
                    :title="tocFilterQuery.trim() ? 'Clear the filter to reorder' : `Move ${item.title} down`"
                    :aria-label="`Move ${item.title} down`"
                    @click="moveTocItem(item, 1)"
                  >↓</button>
                  <button class="toc-outline-edit" type="button" :aria-label="`Edit ${item.title}`" @click="startTocEdit(item)">✎</button>
                  <button class="toc-outline-remove" type="button" :aria-label="`Remove ${item.title}`" @click="removeTocItem(item)">×</button>
                </div>
              </template>
            </li>
          </ul>
          <div v-else-if="tocItems.length" class="toc-outline-no-match">
            <p>No sections match “{{ tocFilterQuery.trim() }}”.</p>
            <button class="toolbar-button subtle" type="button" @click="tocFilterQuery = ''">Clear filter</button>
          </div>
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
          <button v-if="activeTocItem" class="toolbar-button subtle" id="editor-import-file" type="button" @click="importActiveDraftFromFile">Import…</button>
          <button v-if="activeTocItem" class="toolbar-button subtle" id="editor-export-file" type="button" :disabled="!editorContent.trim()" @click="exportActiveDraftToFile">Export…</button>
        </div>
      </header>

      <div class="editor-pane">
        <section v-if="!activeTocItem" class="toc-pick" aria-label="Pick a section to write">
          <div class="toc-pick-card">
            <span class="toc-pick-eyebrow">TEXT EDITOR</span>
            <h2>What are you writing?</h2>
            <p class="toc-pick-hint">Writing always belongs to a declared section. Pick one to load its draft.</p>
            <ul v-if="tocItems.length" class="toc-pick-list">
              <li v-for="item in tocItems" :key="item.id">
                <button class="toc-pick-item" type="button" :data-pick-id="item.id" @click="selectTocItem(item)">
                  <span class="toc-pick-level">H{{ item.level }}</span>
                  <span class="toc-pick-copy">
                    <strong>{{ item.title }}</strong>
                    <small>{{ countWords(item.content) }} word{{ countWords(item.content) === 1 ? '' : 's' }} · {{ item.content ? 'draft saved' : 'no draft yet' }}</small>
                  </span>
                </button>
              </li>
            </ul>
            <div v-else class="toc-pick-empty">
              <h3>No sections yet</h3>
              <p>Declare your first section in the TOC Manager, then pick it here.</p>
            </div>
            <button
              class="toolbar-button"
              :class="tocItems.length ? 'subtle' : 'primary'"
              id="declare-first-section"
              type="button"
              @click="goDeclareSection"
            >{{ tocItems.length ? 'Declare another section' : 'Declare the first section' }}</button>
          </div>
        </section>
        <template v-else>
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
            <span
              v-if="editorNotice"
              id="editor-notice"
              :class="{ error: editorNoticeError }"
              role="status"
            >{{ editorNotice }}</span>
            <span id="cursor-position">{{ cursorPosition }}</span>
          </div>
        </template>
      </div>

      <input
        id="editor-import-input"
        ref="editorImportInput"
        class="sr-only"
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        @change="handleEditorImportFile"
      />
    </section>

    <section v-show="view === 'images'" class="image-app" data-view="images" aria-label="Image viewer application">
      <header class="image-toolbar">
        <div>
          <span class="image-eyebrow">IMAGE VIEWER</span>
          <strong>{{ imageDirectoryName || 'Choose an image directory' }}</strong>
        </div>
        <div class="image-actions">
          <StatusLine
            id="image-status"
            class="image-status"
            :message="imageStatus"
            :error="imageStatusError"
          />
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
          <StatusLine
            id="pdf-status"
            class="pdf-status"
            :message="pdfStatus"
            :error="pdfStatusError"
          />
          <button v-show="pdfDocument" class="toolbar-button primary" id="open-pdf" type="button" @click="openPdf">Open PDF</button>
        </div>
      </header>
      <aside class="toc-sidebar" aria-label="Document table of contents">
        <div class="toc-heading">
          <span>CONTENTS</span>
          <strong id="toc-count">{{ tocCount }}</strong>
        </div>
        <!--
          Not a live region: it wraps the whole interactive outline list, so
          announcing it would read every button on each change. The message it
          shows is a StatusLine, which is the live region.
        -->
        <nav id="toc-panel" class="toc-panel" :data-state="tocState">
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
      <!--
        tabindex + role: the reader pane is a scroll container, so without them
        it can only be driven with a mouse.
      -->
      <div
        id="pdf-content"
        ref="pdfContentElement"
        class="pdf-content"
        role="region"
        aria-label="PDF pages"
        tabindex="0"
        @scroll.passive="handlePdfScroll"
      >
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
      <LightboxDialog
        :image="activeLightboxImage"
        :position="lightboxIndex + 1"
        :total="imageFiles.length"
        :toc-items="tocItems"
        :link-target-id="linkTargetId"
        :link-target="linkTarget"
        @close="closeLightbox"
        @step="changeLightbox"
        @attach="attachImageToToc"
        @update:link-target-id="linkTargetId = $event"
      />
    </Teleport>
  </main>
</template>

