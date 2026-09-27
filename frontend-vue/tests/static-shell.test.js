/*
 * Static contract tests over the composition layer, the template, the
 * stylesheet, the build config, and the native host.
 *
 * `component` aggregates App.vue with its session modules and `nativeHost`
 * aggregates src/*.c with include/*.h, so an assertion keeps working when a
 * concern moves to its own file.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const readAll = (directory, extension) =>
  readdirSync(new URL(directory, import.meta.url))
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => read(`${directory}/${name}`))
    .join('\n');

/*
 * The Vue app is split across App.vue (composition + template) and its
 * session modules, so contract assertions read the whole composition layer.
 * The native host is split across src/*.c with prototypes in include/*.h.
 */
const shellModules = [
  '../src/app-shell.js',
  '../src/components/LightboxDialog.vue',
  '../src/components/MenuView.vue',
  '../src/components/StatusLine.vue',
  '../src/boot-state.js',
  '../src/editor-session.js',
  '../src/file-io.js',
  '../src/image-session.js',
  '../src/native-bridge.js',
  '../src/pdf-session.js',
  '../src/toc-outline.js',
  '../src/workspace-report.js',
];
const component = [read('../src/App.vue'), ...shellModules.map(read)].join(
  '\n',
);
const template = read('../public/index.html');
const config = read('../rsbuild.config.js');
const store = read('../src/workspace.js');
/* The persistence engine, whose behaviour tests/workspace-persistence.test.js owns. */
const persistence = read('../src/workspace-persistence.js');
const styles = read('../src/index.css');
const nativeHost = `${readAll('../../src', '.c')}\n${readAll(
  '../../include',
  '.h',
)}`;

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('Vue app exposes the complete workspace UI and native contracts', () => {
  for (const text of [
    'app-grid',
    'Text Editor',
    'PDF Reader',
    'Image Viewer',
    'TOC Manager',
    'webkitdirectory',
    'openImageDirectory',
    'All Images',
    'ArrowLeft',
    'ArrowRight',
    'Document table of contents',
    'accept="application/pdf,.pdf"',
    'pdfjs-dist',
    'pdfPageCanvases',
    'openPdf',
    'extractPdfToc',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('Vue app uses reactive view state and native Vue event bindings', () => {
  for (const text of [
    'const view = ref(boot.view)',
    'view.value = nextView',
    'v-show="view === \'menu\'"',
    'v-show="view === \'editor\'"',
    'v-show="view === \'pdf\'"',
    'v-show="view === \'images\'"',
    'v-show="view === \'toc\'"',
    'v-show="view === \'map\'"',
    "'pdf-active': view === 'pdf'",
    "'image-active': view === 'images'",
    'pdf-content',
    'toc-panel',
    // The menu routes through MenuView's emit; App.vue owns the handler.
    "emit('select', 'editor')",
    "emit('select', 'pdf')",
    "emit('select', 'images')",
    "emit('select', 'toc')",
    "emit('select', 'map')",
    '@select="selectView"',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('TOC Manager declares outline items and binds editor drafts', () => {
  for (const text of [
    'function selectTocItem(item)',
    'function syncTocDraft()',
    'function addTocItem()',
    'activeTocId.value = item.id',
    'data-view="toc"',
    '{{ documentTitle }}',
    'countWords(item.content)',
    'id="toc-title-input"',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('TOC Manager manages the outline from one surface', () => {
  for (const text of [
    'class="toc-declare-bar"',
    'Add section',
    'id="toc-filter-input"',
    'showTocFilter',
    'filteredTocItems',
    'editingTocId === item.id',
    'id="toc-edit-input"',
    'startTocEdit(item)',
    'saveTocEdit(item)',
    'cancelTocEdit',
    'moveTocItem(item, -1)',
    'moveTocItem(item, 1)',
    'Clear the filter to reorder',
    'id="toc-undo-remove"',
    'undoTocRemoval',
    'lastRemoved',
    'toc-outline-no-match',
    'function saveTocEdit',
    'function startTocEdit',
    'function moveTocItem',
    'function undoTocRemoval',
    'const filteredTocItems',
    'const lastRemoved',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
  assert.doesNotMatch(component, /class="toc-declare"/);
  for (const text of [
    '.toc-declare-bar',
    '.toc-edit',
    '.toc-outline-move',
    '.toc-outline-no-match',
    '.toc-undo',
  ]) {
    assert.match(styles, new RegExp(escapePattern(text)));
  }
});

test('Workspace store owns every persisted key and migration', () => {
  for (const text of [
    'native-workspace.workspace.v1',
    'native-workspace.toc-items.v1',
    'export function loadWorkspace',
    'export function saveWorkspace',
    'export function normalizeWorkspace',
    'export function createTocItem',
    'export function outlineSummary',
  ]) {
    assert.match(store, new RegExp(escapePattern(text)));
  }
  for (const text of [
    'loadWorkspace()',
    'persistWorkspace()',
    'scheduleWorkspaceSave',
    'flushWorkspace',
    'pagehide',
    'watch(',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('Workspace state survives a restart through the native host', () => {
  for (const text of [
    'export function hasNativeWorkspaceStore',
    'export async function loadWorkspaceNative',
    'export function saveWorkspaceNative',
    'savedAt: Math.max(0, Math.floor(Number(source.savedAt) || 0))',
  ]) {
    assert.match(store, new RegExp(escapePattern(text)));
  }
  for (const text of [
    'hydrateNativeWorkspace',
    'createWorkspacePersistence(',
    'persistenceMode',
    'visibilitychange',
    'beforeunload',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
  for (const text of [
    'bind loadWorkspace',
    'bind saveWorkspace',
    'workspace.json',
    'workspace_store_load',
    'workspace_store_save',
  ]) {
    assert.match(nativeHost, new RegExp(escapePattern(text)));
  }
});

test('Assistive-only labels and native file inputs stay out of the layout', () => {
  assert.match(styles, /\.sr-only\s*\{/);
  assert.match(styles, /input\[type="file"\]\s*\{/);
  assert.match(styles, /clip-path:\s*inset\(50%\)/);
  for (const text of [
    'class="sr-only"',
    'id="pdf-file-input"',
    'ref="imageDirectoryInput"',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('Menu cards and tools show live cross-tool state', () => {
  for (const text of [
    '{{ editorBadge }}',
    '{{ pdfBadge }}',
    '{{ imagesBadge }}',
    '{{ outlineBadge }}',
    'id="link-target-select"',
    'attachPdfPageToToc',
    'importPdfHeadingsToToc',
    'attachImageToToc',
    'openLinkedPdfPage',
    'openLinkedImages',
    'openLinkedLocation',
    'attachPlaceToToc',
    'attachLocationToToc',
    'id="map-link-target"',
    'id="map-attach-location"',
    'id="choose-workspace-directory"',
    'id="combine-outline-pdf"',
    'id="preview-outline-pdf"',
    // Saved places: the sidebar, the view options, and the two renderers.
    'id="map-toggle-sidebar"',
    'id="map-save-place"',
    'id="map-clear-places"',
    'id="map-place-count"',
    'id="map-place-status"',
    'class="map-sidebar"',
    'class="map-place-list"',
    'class="map-place-marker"',
    'v-for="place in places"',
    'id="map-filter"',
    'id="map-toggle-renderer"',
    'id="map-toggle-grid"',
    'id="map-toggle-cursor"',
    'id="map-canvas-surface"',
    'class="map-grid-overlay"',
    'class="map-cursor-readout"',
    'addPlace(',
    'startPlaceEdit(',
    'removePlace(',
    'attachPlaceToToc(',
    'goToPlace(',
    'setMapFilter(',
    'setMapRenderer(',
    // Passed straight to the click handler, so it appears without parentheses.
    '@click="toggleMapSidebar"',
    'id="outline-pdf-status"',
    'combineOutlinePdf',
    'previewOutlinePdf',
    'renderOutlinePdf(exportTocJson()',
    'id="open-linked-location"',
    'id="open-linked-pdf"',
    'class="recent-paths"',
    'v-for="path in pdfRecentPaths"',
    '@click="openPdfAt(path)"',
    'class="recent-paths-title"',
    'v-for="path in imageRecentPaths"',
    '@click="openImageDirectoryAt(path)"',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
});

test('neither viewer restores a document on its own', () => {
  for (const text of [
    'resumePdfSession',
    'Could not re-open ',
    'automatically. Use Browse files to pick it again.',
    'pdfPageNumber.value = savedPage',
    'select the folder again to reload',
  ]) {
    assert.ok(!component.includes(text), `viewer still restores via: ${text}`);
  }
  /* The path bindings are what replaced the restore, so they must be wired. */
  assert.ok(component.includes('openPdfAt'));
  assert.ok(component.includes('openImageDirectoryAt'));
});

test('Text editor is a plain writing surface bound to the outline', () => {
  for (const text of [
    'const editorContent = ref',
    ':value="editorContent"',
    'editorContent = $event.target.value',
    'id="previous-outline-item"',
    'id="next-outline-item"',
    'id="back-to-outline"',
    'previousTocItem && selectTocItem(previousTocItem)',
    'spellcheck="true"',
    'auto-saved',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
  for (const text of [
    'Run metrics',
    'id="calculate"',
    'id="copy-result"',
    'id="export-history"',
    'result-panel',
    'right-toolbar',
    'activeTool',
    'parseValues',
    'handleEditorKeydown',
  ]) {
    assert.doesNotMatch(component, new RegExp(escapePattern(text)));
  }
});

test('Opening the text editor requires a picked outline section', () => {
  for (const text of [
    'v-if="!activeTocItem"',
    'class="toc-pick"',
    'aria-label="Pick a section to write"',
    'What are you writing?',
    'class="toc-pick-item"',
    ':data-pick-id="item.id"',
    'selectTocItem(item)',
    'class="toc-pick-empty"',
    'No sections yet',
    'id="declare-first-section"',
    'goDeclareSection',
    "'No section selected'",
    "'Pick a section to start writing'",
    '<template v-else>',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
  for (const text of ['.toc-pick-card', '.toc-pick-item', '.toc-pick-empty']) {
    assert.match(styles, new RegExp(escapePattern(text)));
  }
  assert.doesNotMatch(component, /'untitled\.txt'/);
});

test('WebView template renders before Vue starts', () => {
  assert.match(template, /class="app-grid"/);
  assert.match(template, /data-app="editor"/);
  assert.match(template, /data-app="pdf"/);
  assert.match(template, /data-app="images"/);
  assert.match(template, /data-app="toc"/);
  assert.match(template, /data-app="map"/);
  assert.match(template, /Image Viewer/);
  assert.match(template, /TOC Manager/);
  assert.match(template, /Native Workspace/);
});

test('Rsbuild emits a self-contained all-in-one bundle', () => {
  for (const text of [
    'inlineScripts: true',
    'inlineStyles: true',
    "strategy: 'all-in-one'",
    'pluginSingleFileHtml',
    "inject: 'body'",
    "scriptLoading: 'blocking'",
  ]) {
    assert.match(config, new RegExp(text));
  }
});

test('Long state text never escapes its menu, toolbar, or sidebar', () => {
  for (const pattern of [
    /\.app-card\s*\{[^}]*overflow:\s*hidden/,
    /\.app-card-copy\s*\{[^}]*min-width:\s*0/,
    /\.app-card-copy strong\s*\{[^}]*text-overflow:\s*ellipsis/,
    /\.app-card-copy small\s*\{[^}]*-webkit-line-clamp:\s*2/,
    /\.app-card-copy small\s*\{[^}]*overflow-wrap:\s*anywhere/,
    /\.toolbar-button\s*\{[^}]*flex-shrink:\s*0/,
    /\.pdf-actions\s*\{[^}]*min-width:\s*0/,
    /\.image-actions\s*\{[^}]*min-width:\s*0/,
    /\.toc-manager-actions\s*\{[^}]*min-width:\s*0/,
    /\.pdf-status\s*,[\s\S]*?\.toc-manager-status\s*\{[^}]*text-overflow:\s*ellipsis/,
    /\.image-group-button span\s*\{[^}]*text-overflow:\s*ellipsis/,
    /\.image-group-button small\s*\{[^}]*flex-shrink:\s*0/,
    /\.toc-item\s*\{[^}]*overflow-wrap:\s*anywhere/,
    /#cursor-position\s*\{[^}]*flex-shrink:\s*0/,
    /\.recent-path\s*\{[^}]*overflow-wrap:\s*anywhere/,
  ]) {
    assert.match(styles, pattern);
  }
  for (const text of [
    ':title="editorBadge"',
    ':title="pdfBadge"',
    ':title="imagesBadge"',
    ':title="outlineBadge"',
    ':message="pdfStatus"',
    ':message="imageStatus"',
    ':message="tocStatus"',
    ':title="group.name"',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('Returning to the PDF reader repaints canvases and keeps the page', () => {
  assert.match(component, /watch\(\s*view,\s*async \(current, previous\)/);
  for (const text of [
    "current !== 'pdf'",
    "previous === 'pdf'",
    'await renderAllPdfPages();',
    'scrollToPdfPage(pdfPageNumber.value)',
    'pdfPageCanvases.delete(pageNumber)',
    'canvas?.isConnected',
    'if (element) pdfPageCanvases.set(pageNumber, element);',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('Each viewer exposes one picker sharing one native call path', () => {
  assert.match(component, /v-show="pdfDocument"[^>]*id="open-pdf"/);
  assert.match(
    component,
    /v-show="imageFiles\.length > 0"[^>]*id="open-image-directory"/,
  );
  assert.doesNotMatch(
    component,
    /getOpenPdf|getExtractPdfToc|getOpenImageDirectory/,
  );
  for (const text of [
    'function getNativeBinding(',
    'async function runNativeCall(',
    "native('openPdf')",
    "native('openImageDirectory')",
    "native('extractPdfToc')",
    'call(openPdfFile)',
    'call(openDirectory)',
    'call(extractToc)',
    'id="browse-pdf"',
    'id="browse-image-directory"',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
  for (const text of [
    'char *run_path_chooser(',
    'int dispatch_picker(',
    'void return_native_error(',
    'PICKER_OPEN_FILE',
    'PICKER_SELECT_FOLDER',
    '"openPdf"',
    '"openImageDirectory"',
  ]) {
    assert.ok(nativeHost.includes(text), `missing ${text}`);
  }
  assert.doesNotMatch(
    nativeHost,
    /return_pdf_error|return_image_error|pdf_open_request|image_directory_request/,
  );
});

test('Workspace persistence failures surface as a visible report', () => {
  for (const text of [
    'id="workspace-report"',
    'id="dismiss-workspace-report"',
    'class="workspace-report"',
    'createWorkspacePersistence(',
    'getWorkspaceReport',
    'workspaceReport',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
  for (const text of [
    'store.loadWorkspaceNative()',
    'store.saveWorkspaceNative(serialized)',
    'restored.savedAt < bootSavedAt',
    'store.hasUserInteracted()',
    'function hydrate()',
  ]) {
    assert.ok(persistence.includes(text), `missing ${text}`);
  }
  for (const text of [
    'export function getWorkspaceReport',
    'function recordWorkspaceReport',
    "code: 'INVALID_CONTENT'",
    "code: 'WRITE_FAILED'",
  ]) {
    assert.ok(store.includes(text), `missing ${text}`);
  }
  assert.ok(nativeHost.includes('INVALID_CONTENT'), 'missing INVALID_CONTENT');
  assert.match(styles, /\.workspace-report\s*\{/);
});

test('The composition layer flushes and cleans up on lifecycle boundaries', () => {
  for (const text of [
    "window.addEventListener('pagehide', flushWorkspace)",
    "window.addEventListener('beforeunload', flushWorkspace)",
    "document.addEventListener('visibilitychange', handleVisibilityChange)",
    'onBeforeUnmount(() => {',
    "window.removeEventListener('pagehide', flushWorkspace)",
    "window.removeEventListener('beforeunload', flushWorkspace)",
    "document.removeEventListener('visibilitychange', handleVisibilityChange)",
    'flushWorkspace();',
    'disposePdfSession();',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('Leaving the editor syncs the draft and the outline can force a save', () => {
  for (const text of [
    'onViewLeaveEditor(() => syncTocDraft());',
    'configureTocOutline({ persistNow: () => persistWorkspace() });',
    'scheduleWorkspaceSave',
    'hydrateNativeWorkspace();',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('A dismissed report stays away until persistence fails again', () => {
  for (const text of [
    'workspaceReport = null',
    '@click="workspaceReport = null"',
    'v-if="workspaceReport"',
    'v-else',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
  for (const text of [
    'workspaceReport.value = report(store.getWorkspaceReport())',
  ]) {
    assert.ok(persistence.includes(text), `missing ${text}`);
  }
  for (const text of [
    'export function getWorkspaceReport',
    'export function clearWorkspaceReport',
    'function clearSaveReport()',
    "workspaceReport.scope === 'save'",
  ]) {
    assert.ok(store.includes(text), `missing ${text}`);
  }
  for (const text of [
    'Workspace not saved: ',
    'Saved workspace not restored: ',
    'export function formatWorkspaceReport',
  ]) {
    assert.ok(
      read('../src/workspace-report.js').includes(text),
      `missing ${text}`,
    );
  }
});

test('Every source and test file opens with a documentation comment', () => {
  const listFiles = (directory, extension) =>
    readdirSync(new URL(directory, import.meta.url))
      .filter((name) => name.endsWith(extension))
      .sort()
      .map((path) => [`${directory}/${path}`, read(`${directory}/${path}`)]);

  const documented = [
    ...shellModules.map((path) => [path, read(path)]),
    ...listFiles('../src', '.js'),
    ...listFiles('../tests', '.js'),
    ...listFiles('../../src', '.c'),
    ...listFiles('../../include', '.h'),
    ...listFiles('../../tests', '.c'),
    ...listFiles('../../tests', '.lua'),
  ];

  for (const [path, text] of documented) {
    if (path.endsWith('.lua')) {
      assert.match(text, /^--/, `${path} has no file header comment`);
    } else if (path.endsWith('.js')) {
      assert.match(text, /^\/\*/, `${path} has no file header comment`);
    } else {
      assert.match(
        text.slice(0, 4000),
        /\/\*/,
        `${path} has no file header comment`,
      );
    }
  }
});

test('Import and export actions are wired for the outline and the draft', () => {
  for (const text of [
    'id="toc-import-json"',
    'id="toc-export-json"',
    '@click="importTocFromFile"',
    '@click="exportTocToFile"',
    ':disabled="tocItems.length === 0"',
    'id="toc-import-input"',
    'ref="tocImportInput"',
    'accept=".json,application/json"',
    '@change="handleTocImportFile"',
    'id="editor-import-file"',
    'id="editor-export-file"',
    '@click="importActiveDraftFromFile"',
    '@click="exportActiveDraftToFile"',
    ':disabled="!editorContent.trim()"',
    'id="editor-import-input"',
    'ref="editorImportInput"',
    'accept=".txt,.md,.markdown,text/plain,text/markdown"',
    '@change="handleEditorImportFile"',
    'id="editor-notice"',
    "from './file-io.js'",
    'readTextFileNative',
    'readFileAsText',
    'writeTextFile',
    'suggestFileName',
    "format: 'metrics-toc'",
    'applyDraftImport',
    'Draft replaced by',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
  for (const text of ['#editor-notice', '#editor-notice.error']) {
    assert.match(styles, new RegExp(escapePattern(text)));
  }
  for (const text of [
    'bind openTextFile',
    'bind saveTextFile',
    'on_open_text_file',
    'on_save_text_file',
    'PICKER_SAVE_FILE',
    'TEXT_TRANSFER_MAX_BYTES',
    'do_overwrite_confirmation',
  ]) {
    assert.match(nativeHost, new RegExp(escapePattern(text)));
  }
});

/*
 * The accessibility gaps found in the abstraction audit, now closed: one
 * status vocabulary, a lightbox that traps and restores focus, a TOC panel
 * that is not a live region, and a keyboard-reachable reader pane.
 */
test('Every pane reports through the one shared status line', () => {
  for (const text of [
    'id="toc-manager-status"',
    'id="image-status"',
    'id="pdf-status"',
    'id="editor-notice"',
  ]) {
    assert.ok(component.includes(`<StatusLine`), 'App.vue must use StatusLine');
    assert.ok(component.includes(text), `missing ${text}`);
  }
  for (const text of [
    'class="status-line"',
    ':class="{ error }"',
    'role="status"',
    ':aria-live="live"',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('The lightbox keeps and returns focus', () => {
  for (const text of [
    'previouslyFocused = document.activeElement',
    "event.key !== 'Tab'",
    'previouslyFocused.focus()',
    'aria-modal="true"',
    "document.querySelector('.lightbox')?.focus()",
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('The interactive TOC panel is not announced as a live region', () => {
  const panel = /<nav id="toc-panel"[^>]*>/.exec(component);
  assert.ok(panel, 'the TOC panel must exist');
  assert.ok(
    !panel[0].includes('aria-live'),
    'a nav of buttons must not be a live region',
  );
});

test('The reader pane can be scrolled with the keyboard', () => {
  const region = /<div[^>]*id="pdf-content"[^>]*>/.exec(component);
  assert.ok(region, 'the reader pane must exist');
  assert.match(region[0], /tabindex="0"/);
  assert.match(region[0], /role="region"/);
  assert.match(region[0], /aria-label="PDF pages"/);
});
