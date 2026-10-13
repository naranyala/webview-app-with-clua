<script setup>
/*
 * TocPane - the TOC Manager pane.
 *
 * Extracted from App.vue, which was one file holding the shell and every pane's
 * template at once. The session state this pane reads is still owned by the
 * modules App.vue composes - this file adds markup and the few handlers that are
 * specific to one pane, and nothing else.
 *
 * Generated from the pane's own template by a one-shot tool, so the imports below
 * are exactly the bindings the template references and nothing was dropped in the
 * move. tests/template-bindings.test.js checks that claim over every component.
 */
import { computed, nextTick, ref, watch } from 'vue';
import { markUserInteracted, selectView, view } from '../app-shell.js';
import { suggestFileName } from '../file-io.js';
import { formatCoordinates } from '../geo.js';
import {
  chooseWorkspaceDirectory,
  lastOutlinePdf,
  outlinePdfBusy,
  outlinePdfStatus,
  outlinePdfStatusError,
  outlinePdfSummary,
  renderOutlinePdf,
  setOutlinePdfStatus,
  workspaceDirectory,
} from '../outline-pdf.js';
import { openPdfAt } from '../pdf-session.js';
import {
  activeTocId,
  addTocItem,
  cancelTocEdit,
  editingTocId,
  exportTocJson,
  exportTocToFile,
  filteredTocItems,
  handleTocImportFile,
  importTocFromFile,
  lastRemoved,
  moveTocItem,
  openLinkedImages,
  openLinkedLocation,
  openLinkedPdfPage,
  removeTocItem,
  saveTocEdit,
  selectTocItem,
  showTocFilter,
  startTocEdit,
  tocDraftLevel,
  tocDraftTitle,
  tocEditLevel,
  tocEditTitle,
  tocFilterQuery,
  tocItemLabel,
  tocItems,
  tocStatus,
  tocStatusError,
  undoTocRemoval,
} from '../toc-outline.js';
import { countWords, plural } from '../workspace.js';
import { scheduleWorkspaceSave } from '../workspace-persistence.js';
import StatusLine from './StatusLine.vue';

const combinedDocumentTitle = computed(
  () => tocItems.value[0]?.title || 'Outline',
);

async function combineOutlinePdf() {
  if (tocItems.value.length === 0) {
    setOutlinePdfStatus('Declare at least one section before combining.', true);
    return;
  }
  const suggested = suggestFileName(
    combinedDocumentTitle.value,
    'pdf',
    'outline',
  );
  const written = await renderOutlinePdf(exportTocJson(), suggested);
  if (!written) return;
  markUserInteracted();
  scheduleWorkspaceSave();
}

async function previewOutlinePdf() {
  const path = lastOutlinePdf.value?.path;
  if (!path) {
    setOutlinePdfStatus('There is no combined PDF to preview yet.', true);
    return;
  }
  selectView('pdf');
  await openPdfAt(path);
}
</script>

<template>
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
          <button class="toolbar-button subtle" id="choose-workspace-directory" type="button" :disabled="outlinePdfBusy" @click="chooseWorkspaceDirectory">Workspace folder…</button>
          <button class="toolbar-button primary" id="combine-outline-pdf" type="button" :disabled="tocItems.length === 0 || outlinePdfBusy" @click="combineOutlinePdf">Combine to PDF</button>
          <button v-if="lastRemoved" class="toolbar-button subtle toc-undo" id="toc-undo-remove" type="button" @click="undoTocRemoval">Undo remove</button>
          <button class="toolbar-button subtle" id="resume-writing" type="button" :disabled="!activeTocId" @click="selectView('editor')">Resume writing</button>
        </div>
      </header>

      <!--
        The combined PDF is a plain file in the one workspace folder, so this bar
        only reports where it went and offers the preview. The preview is the
        existing reader, opened by path - nothing is held in memory.
      -->
      <div v-if="workspaceDirectory || lastOutlinePdf" class="outline-pdf-bar">
        <span class="outline-pdf-label" :title="workspaceDirectory">
          {{ workspaceDirectory || 'No workspace folder chosen' }}
        </span>
        <StatusLine
          id="outline-pdf-status"
          class="outline-pdf-status"
          :message="outlinePdfStatus"
          :error="outlinePdfStatusError"
        />
        <button
          v-if="lastOutlinePdf"
          class="toolbar-button subtle"
          id="preview-outline-pdf"
          type="button"
          @click="previewOutlinePdf"
        >Preview {{ outlinePdfSummary }}</button>
      </div>

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
                  <small>{{ countWords(item.content) }} {{ plural(countWords(item.content), 'word') }} · {{ item.content ? 'draft saved' : 'no draft yet' }}</small>
                </button>
                <div class="toc-outline-meta">
                  <span class="toc-outline-level">H{{ item.level }}</span>
                  <button v-if="item.links.pdfPage" class="toc-outline-link" type="button" :title="`Open ${item.links.pdfName || 'the PDF'} at page ${item.links.pdfPage}`" @click="openLinkedPdfPage(item)">p.{{ item.links.pdfPage }}</button>
                  <button v-if="item.links.images.length" class="toc-outline-link" type="button" :title="`${item.links.images.length} attached image(s)`" @click="openLinkedImages(item)">IMG {{ item.links.images.length }}</button>
                  <button
                    v-if="item.links.location"
                    class="toc-outline-link map-outline-link"
                    type="button"
                    :title="`Show ${item.links.location.label || 'the saved place'} at ${formatCoordinates(item.links.location)}`"
                    @click="openLinkedLocation(item)"
                  >LOC</button>
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

</template>
