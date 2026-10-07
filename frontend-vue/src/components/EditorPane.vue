<script setup>
/*
 * EditorPane - the Text Editor pane, gate and body.
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
import { computed, defineProps, nextTick, watch } from 'vue';
import { selectView, view } from '../app-shell.js';
import {
  cursorPosition,
  editorContent,
  editorNotice,
  editorNoticeError,
  editorWordCount,
  updateCursor,
} from '../editor-session.js';
import {
  activeTocIndex,
  activeTocItem,
  exportActiveDraftToFile,
  handleEditorImportFile,
  importActiveDraftFromFile,
  nextTocItem,
  openLinkedLocation,
  openLinkedPdfPage,
  previousTocItem,
  selectTocItem,
  syncTocDraft,
  tocItems,
} from '../toc-outline.js';
import { countWords } from '../workspace.js';
import { saveLabelFor } from '../workspace-persistence.js';

const documentTitle = computed(() =>
  activeTocItem.value ? activeTocItem.value.title : 'No section selected',
);

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

function goDeclareSection() {
  selectView('toc');
  nextTick(() => document.getElementById('toc-title-input')?.focus());
}
/*
 * Where the workspace is currently being kept.
 *
 * A prop rather than an import: persistenceMode belongs to the engine instance
 * App.vue creates, and reaching into that instance from here would make this pane
 * depend on the shell's construction rather than on its state. The phrase itself
 * is a shared pure function, so the shell's tool badge and this status bar cannot
 * describe the same mode differently.
 */
const props = defineProps({
  persistenceMode: { type: String, default: 'local' },
});

const saveLabel = computed(() => saveLabelFor(props.persistenceMode));
</script>

<template>
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
          <button v-if="activeTocItem?.links?.location" class="toolbar-button subtle" id="open-linked-location" type="button" @click="openLinkedLocation(activeTocItem)">Location</button>
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

</template>
