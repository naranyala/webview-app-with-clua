import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8',
);
const component = readFileSync(
  new URL('../src/App.tsrx', import.meta.url),
  'utf8',
);

test('shell and component expose the app grid and PDF reader', () => {
  for (const source of [shell, component]) {
    assert.match(source, /class="app-grid"/);
    assert.match(source, /data-app="editor"/);
    assert.match(source, /data-app="pdf"/);
    assert.match(source, /Text Editor/);
    assert.match(source, /PDF Reader/);
    assert.match(source, /accept="application\/pdf,\.pdf"/);
    assert.match(source, /type="application\/pdf"/);
    assert.match(source, /Document table of contents/);
    assert.match(source, /toc-panel/);
  }
});

test('static WebView shell and Octane component share the editor contract', () => {
  assert.match(shell, /id="root"/, 'shell is missing #root');
  for (const id of [
    'values',
    'calculate',
    'new-document',
    'copy-result',
    'export-history',
    'tool-run',
    'tool-clear',
    'tool-info',
    'tool-edit',
    'result',
    'cursor-position',
    'document-status',
    'editor-help',
    'back-to-menu',
    'open-pdf',
    'browse-pdf',
    'pdf-file-input',
    'pdf-name',
    'pdf-status',
    'pdf-viewer',
    'toc-panel',
    'toc-count',
  ]) {
    assert.match(
      component,
      new RegExp(`id="${id}"`),
      `component is missing #${id}`,
    );
    assert.match(shell, new RegExp(`id="${id}"`), `shell is missing #${id}`);
  }

  for (const text of [
    'Run metrics',
    'Copy',
    'New',
    'Export',
    '12.5, 15, 8.5, 14',
  ]) {
    assert.match(
      shell,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(
      component,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
});

test('shell and component have matching structural elements', () => {
  const classes = [
    'editor-app',
    'topbar',
    'brand',
    'brand-mark',
    'brand-name',
    'top-actions',
    'editor-layout',
    'editor-pane',
    'editor-meta',
    'editor-footer',
    'right-toolbar',
    'result-panel',
    'result-heading',
    'placeholder',
    'rail-button',
    'rail-spacer',
    'toolbar-button',
  ];

  for (const cls of classes) {
    assert.match(
      shell,
      new RegExp(`class="[^"]*${cls}[^"]*"`),
      `shell is missing .${cls}`,
    );
    assert.match(
      component,
      new RegExp(`class="[^"]*${cls}[^"]*"`),
      `component is missing .${cls}`,
    );
  }
});

test('shell and component have matching ARIA labels', () => {
  const labels = ['Text editor', 'Editor tools', 'Metrics result'];
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      shell,
      new RegExp(`aria-label="${escaped}"`),
      `shell is missing aria-label="${label}"`,
    );
    assert.match(
      component,
      new RegExp(`aria-label="${escaped}"`),
      `component is missing aria-label="${label}"`,
    );
  }
});

test('shell and component default textarea value matches', () => {
  const extractTextareaValue = (html) => {
    const idx = html.indexOf('id="values"');
    assert.ok(idx !== -1, 'textarea with id="values" not found');
    const afterId = html.indexOf('</textarea>', idx);
    assert.ok(afterId !== -1, '</textarea> not found after id="values"');
    const snippet = html.slice(idx, afterId);
    const lastClose = snippet.lastIndexOf('>');
    return snippet.slice(lastClose + 1).trim();
  };
  const shellVal = extractTextareaValue(shell);
  const compVal = extractTextareaValue(component);
  assert.ok(shellVal.length > 0, 'shell textarea is empty');
  assert.ok(compVal.length > 0, 'component textarea is empty');
  assert.equal(shellVal, compVal, 'textarea default values must match');
});

test('shell has result-status placeholder text', () => {
  assert.match(shell, /No result yet/);
  assert.match(component, /No result yet/);
});
