import { getErrorMessage, parseValues, renderSummary } from './metrics-ui.js';

import './App.css';

function updateCursorPosition() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const position = document.getElementById('cursor-position');
  if (!input || !position) return;

  const beforeCursor = input.value.slice(0, input.selectionStart ?? 0);
  const lines = beforeCursor.split('\n');
  position.textContent = `Line ${lines.length}, Col ${lines.at(-1).length + 1}`;
}

function clearDocument() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const result = document.getElementById('result');
  const status = document.getElementById('document-status');
  if (!input || !result || !status) return;

  input.value = '';
  result.className = 'result-panel';
  result.innerHTML = '<div class="result-heading"><span>OUTPUT</span><span>No result yet</span></div><p class="placeholder">Run metrics to inspect the native calculation.</p>';
  status.textContent = 'Empty document';
  updateCursorPosition();
  input.focus();
}

function showHelp() {
  const result = document.getElementById('result');
  if (!result) return;

  result.className = 'result-panel';
  result.innerHTML = '<div class="result-heading"><span>HELP</span><span>Editor</span></div><p class="placeholder">Enter comma-separated finite numbers, then choose Run metrics from the top or right toolbar.</p>';
}

async function calculate() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const result = document.getElementById('result');
  const button = document.getElementById('calculate') as HTMLButtonElement;
  const runTool = document.getElementById('tool-run') as HTMLButtonElement;
  const status = document.getElementById('document-status');
  if (!input || !result || !button || !runTool || !status) return;

  const parsed = parseValues(input.value);
  if (!parsed.ok) {
    result.className = 'result-panel error';
    result.innerHTML = `<div class="result-heading"><span>OUTPUT</span><span>Input error</span></div><p>${parsed.message}</p>`;
    status.textContent = 'Needs attention';
    return;
  }

  button.disabled = true;
  runTool.disabled = true;
  button.textContent = 'Running…';
  result.className = 'result-panel loading';
  result.innerHTML = '<div class="result-heading"><span>OUTPUT</span><span>Processing…</span></div><p>Sending samples to the native C engine…</p>';
  status.textContent = 'Processing';

  try {
    const summarize =
      typeof window.summarize === 'function'
        ? window.summarize
        : window.__webview__ && typeof window.__webview__.call === 'function'
          ? (values: number[]) => window.__webview__.call('summarize', values)
          : null;
    if (!summarize) {
      throw new Error('The native WebView bridge is unavailable. Run the desktop app to calculate metrics.');
    }

    const summary = await summarize(parsed.values);
    if (summary.error) throw new Error(getErrorMessage(summary.error));
    result.className = 'result-panel';
    result.innerHTML = '<div class="result-heading"><span>OUTPUT</span><span>Complete</span></div>' + renderSummary(summary);
    status.textContent = 'Saved result';
  } catch (error) {
    result.className = 'result-panel error';
    result.innerHTML = `<div class="result-heading"><span>OUTPUT</span><span>Bridge error</span></div><p>${getErrorMessage(error)}</p>`;
    status.textContent = 'Failed';
  } finally {
    button.disabled = false;
    runTool.disabled = false;
    button.textContent = 'Run metrics';
  }
}

export function App() @{
  <main class="editor-app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">N</span>
        <span class="brand-name">Plaintext</span>
      </div>
      <div class="document-title" aria-live="polite">untitled.txt</div>
      <div class="top-actions">
        <button class="toolbar-button subtle" id="new-document" type="button" onclick={clearDocument}>New</button>
        <button class="toolbar-button primary" id="calculate" type="button" onclick={calculate}>Run metrics</button>
      </div>
    </header>

    <div class="editor-layout">
      <section class="editor-pane" aria-label="Text editor">
        <div class="editor-meta">
          <span>INPUT</span>
          <span id="cursor-position">Line 1, Col 1</span>
        </div>
        <label class="sr-only" for="values">Document text</label>
        <textarea id="values" spellcheck="false" aria-describedby="editor-help" oninput={updateCursorPosition} onclick={updateCursorPosition} onkeyup={updateCursorPosition}>12.5, 15, 8.5, 14</textarea>
        <div class="editor-footer">
          <span id="editor-help">Comma-separated numbers are sent to the native C engine.</span>
          <span id="document-status">Ready</span>
        </div>
      </section>

      <aside class="right-toolbar" aria-label="Editor tools">
        <button class="rail-button active" id="tool-edit" type="button" aria-label="Edit document" title="Edit document"><span aria-hidden="true">✎</span></button>
        <button class="rail-button" id="tool-run" type="button" aria-label="Run metrics" title="Run metrics" onclick={calculate}><span aria-hidden="true">▶</span></button>
        <button class="rail-button" id="tool-clear" type="button" aria-label="Clear document" title="Clear document" onclick={clearDocument}><span aria-hidden="true">⌫</span></button>
        <div class="rail-spacer"></div>
        <button class="rail-button" id="tool-info" type="button" aria-label="Show help" title="Show help" onclick={showHelp}><span aria-hidden="true">?</span></button>
      </aside>
    </div>

    <section id="result" class="result-panel" aria-live="polite" aria-label="Metrics result">
      <div class="result-heading"><span>OUTPUT</span><span>No result yet</span></div>
      <p class="placeholder">Run metrics to inspect the native calculation.</p>
    </section>
  </main>
}
