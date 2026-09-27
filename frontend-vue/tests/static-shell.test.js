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
  '../src/boot-state.js',
  '../src/editor-session.js',
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
    /\.pdf-resume\s*\{[^}]*overflow-wrap:\s*anywhere/,
  ]) {
    assert.match(styles, pattern);
  }
  for (const text of [
    ':title="editorBadge"',
    ':title="pdfBadge"',
    ':title="imagesBadge"',
    ':title="outlineBadge"',
    ':title="pdfStatus"',
    ':title="imageStatus"',
    ':title="tocStatus"',
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
    "getNativeBinding('openPdf')",
    "getNativeBinding('openImageDirectory')",
    "getNativeBinding('extractPdfToc')",
    'runNativeCall(openPdfFile)',
    'runNativeCall(openDirectory)',
    'runNativeCall(extractToc)',
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
    'refreshWorkspaceReport',
    'getWorkspaceReport',
    'workspaceReport.value',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
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
    'onViewEnterPdf(() => {',
    'scheduleWorkspaceSave',
    'hydrateNativeWorkspace();',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
  }
});

test('A dismissed report stays away until persistence fails again', () => {
  for (const text of [
    'refreshWorkspaceReport();',
    'function refreshWorkspaceReport()',
    'workspaceReport.value = formatWorkspaceReport(getWorkspaceReport())',
    '@click="workspaceReport = null"',
    'v-if="workspaceReport"',
    'v-else',
  ]) {
    assert.ok(component.includes(text), `missing ${text}`);
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
