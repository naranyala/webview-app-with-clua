import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const component = readFileSync(
  new URL('../src/App.vue', import.meta.url),
  'utf8',
);
const template = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8',
);
const config = readFileSync(
  new URL('../rsbuild.config.js', import.meta.url),
  'utf8',
);
const store = readFileSync(
  new URL('../src/workspace.js', import.meta.url),
  'utf8',
);
const styles = readFileSync(
  new URL('../src/index.css', import.meta.url),
  'utf8',
);
const nativeHost = readFileSync(
  new URL('../../src/webview_app.c', import.meta.url),
  'utf8',
);

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
    'const view = ref(restoredWorkspace.view)',
    'view.value = nextView',
    'v-show="view === \'menu\'"',
    'v-show="view === \'editor\'"',
    'v-show="view === \'pdf\'"',
    'v-show="view === \'images\'"',
    'v-show="view === \'toc\'"',
    "'pdf-active': view === 'pdf'",
    "'image-active': view === 'images'",
    'pdf-content',
    'toc-panel',
    '@click="selectView(\'editor\')"',
    '@click="selectView(\'pdf\')"',
    '@click="selectView(\'images\')"',
    '@click="selectView(\'toc\')"',
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
    'applyWorkspace(snapshot)',
    'loadWorkspaceNative()',
    'saveWorkspaceNative(serialized)',
    'persistenceMode',
    'saved to disk',
    'visibilitychange',
    'beforeunload',
    'snapshot.savedAt < restoredWorkspace.savedAt',
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
    'id="open-linked-pdf"',
    'id="resume-pdf"',
    'resumePdfSession',
    'Could not re-open ',
    'automatically. Use Browse files to pick it again.',
    'pdfPageNumber.value = savedPage',
  ]) {
    assert.match(component, new RegExp(escapePattern(text)));
  }
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

test('WebView template renders before Vue starts', () => {
  assert.match(template, /class="app-grid"/);
  assert.match(template, /data-app="editor"/);
  assert.match(template, /data-app="pdf"/);
  assert.match(template, /data-app="images"/);
  assert.match(template, /data-app="toc"/);
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
