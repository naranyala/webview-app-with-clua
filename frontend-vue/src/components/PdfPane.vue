<script setup>
/*
 * PdfPane - the PDF Reader pane.
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
import { view } from '../app-shell.js';
import {
  activePage,
  changePdfPage,
  handlePdfFile,
  handlePdfScroll,
  navigateToPage,
  openPdf,
  openPdfAt,
  pdfDocument,
  pdfLoading,
  pdfName,
  pdfPageCount,
  pdfPageNumber,
  pdfRecentPaths,
  pdfRenderError,
  pdfSidebarOpen,
  pdfStatus,
  pdfStatusError,
  pdfZoom,
  setPdfPageCanvas,
  tocCached,
  tocCount,
  tocHeadings,
  tocMessage,
  tocState,
  togglePdfSidebar,
  zoomPdfTo,
} from '../pdf-session.js';
import {
  attachPdfPageToToc,
  importPdfHeadingsToToc,
  linkTarget,
  linkTargetId,
  tocItems,
} from '../toc-outline.js';
import { plural } from '../workspace.js';
import StatusLine from './StatusLine.vue';
</script>

<template>
    <section
      v-show="view === 'pdf'"
      class="pdf-app"
      :class="{ 'sidebar-closed': !pdfSidebarOpen }"
      data-view="pdf"
      aria-label="PDF reader application"
    >
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
          <button
            class="toolbar-button subtle"
            id="pdf-toggle-sidebar"
            type="button"
            :aria-expanded="pdfSidebarOpen"
            aria-controls="pdf-sidebar"
            @click="togglePdfSidebar"
          >
            {{ pdfSidebarOpen ? 'Hide contents' : 'Contents' }}
          </button>
        </div>
      </header>
      <!--
        Hidden with visibility, never unmounted, so a closed panel keeps its
        scroll position. Below the narrow breakpoint it overlays the page canvas
        instead of taking a column of it, which is what leaves a 360px phone a
        usable 360px reader rather than 195px.
      -->
      <button
        v-show="!pdfSidebarOpen"
        class="sidebar-backdrop"
        type="button"
        tabindex="-1"
        aria-label="Close the contents panel"
        @click="togglePdfSidebar"
      />
      <aside
        id="pdf-sidebar"
        class="toc-sidebar"
        :class="{ closed: !pdfSidebarOpen }"
        aria-label="Document table of contents"
      >
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
          <button class="toolbar-button subtle" type="button" :disabled="!tocHeadings.length" @click="importPdfHeadingsToToc">Import {{ tocHeadings.length }} {{ plural(tocHeadings.length, 'heading') }}</button>
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
          <h2>Open a PDF</h2>
          <p>Pick a remembered document below, or browse this computer for a new one.</p>
          <button class="toolbar-button primary" id="browse-pdf" type="button" @click="openPdf">Browse files</button>
          <!--
            The remembered list replaces the old auto-restore: a stored document
            is only re-opened when its path is chosen here, so nothing is read
            from disk behind the user's back.
          -->
          <div v-if="pdfRecentPaths.length" class="recent-paths" aria-label="Remembered documents">
            <span class="recent-paths-title">REMEMBERED</span>
            <ul class="recent-paths-list">
              <li v-for="path in pdfRecentPaths" :key="path">
                <button class="recent-path" type="button" :disabled="pdfLoading" :title="path" @click="openPdfAt(path)">{{ path }}</button>
              </li>
            </ul>
          </div>
        </div>
        <div v-show="pdfDocument" class="pdf-rendered" aria-label="Selected PDF document">
          <div class="pdf-page-controls">
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber <= 1" @click="changePdfPage(-1)">Previous</button>
            <span>Page {{ pdfPageNumber }} of {{ pdfPageCount }}</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber >= pdfPageCount" @click="changePdfPage(1)">Next</button>
            <span class="pdf-zoom-label">Zoom</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="zoomPdfTo(-0.1)">−</button>
            <span>{{ Math.round(pdfZoom * 100) }}%</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="zoomPdfTo(0.1)">+</button>
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

</template>
