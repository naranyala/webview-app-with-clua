import { getErrorMessage, getErrorCategory, renderSummary, renderError, parseValues } from './metrics-ui.js';

import './App.css';

interface CalculationHistory {
  input: string;
  summary: Record<string, number> | null;
  error: string | null;
  errorCode: string | null;
  errorCategory: string | null;
  timestamp: number;
}

const calculationHistory: CalculationHistory[] = [];

function updateCursorPosition() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const position = document.getElementById('cursor-position');
  if (!input || !position) return;

  const beforeCursor = input.value.slice(0, input.selectionStart ?? 0);
  const lines = beforeCursor.split('\n');
  position.textContent = `Line ${lines.length}, Col ${lines.at(-1).length + 1}`;
}

function updateInputStats() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const status = document.getElementById('document-status');
  if (!input || !status) return;

  const text = input.value.trim();
  if (!text) {
    status.textContent = 'Empty document';
    return;
  }

  const tokens = text.split(',').map(t => t.trim()).filter(t => t !== '');
  const validCount = tokens.filter(t => !isNaN(Number(t)) && Number.isFinite(Number(t))).length;
  status.textContent = `${validCount} number${validCount !== 1 ? 's' : ''} detected`;
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
  result.innerHTML = `
    <div class="result-heading"><span>HELP</span><span>Editor</span></div>
    <div class="help-content">
      <p><strong>Input Format:</strong> Enter comma-separated finite numbers (e.g., 12.5, 15, 8.5, 14)</p>
      <p><strong>Supported:</strong> Integers, decimals, negative numbers, scientific notation</p>
      <p><strong>Keyboard Shortcuts:</strong></p>
      <ul>
        <li><kbd>Ctrl</kbd> + <kbd>Enter</kbd> - Run metrics</li>
      </ul>
      <p><strong>Features:</strong></p>
      <ul>
        <li>Real-time input validation</li>
        <li>Calculation history tracking</li>
        <li>Copy results to clipboard</li>
        <li>Export history as JSON</li>
      </ul>
    </div>`;
}

async function copyResult() {
  const result = document.getElementById('result');
  const status = document.getElementById('document-status');
  if (!result || !status) return;

  const text = result.innerText.trim();
  if (!text || text.includes('Run metrics to inspect')) {
    status.textContent = 'Nothing to copy';
    return;
  }

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(result);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('copy');
      selection?.removeAllRanges();
    }
    status.textContent = 'Result copied';
  } catch (err) {
    status.textContent = 'Copy failed';
    console.error('Copy failed:', err);
  }
}

function exportHistory() {
  const status = document.getElementById('document-status');
  if (!status) return;

  if (calculationHistory.length === 0) {
    status.textContent = 'No history to export';
    return;
  }

  try {
    const data = JSON.stringify(calculationHistory, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `metrics-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    status.textContent = 'History exported';
  } catch (err) {
    status.textContent = 'Export failed';
    console.error('Export failed:', err);
  }
}

function handleEditorKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    calculate();
  }
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
    result.innerHTML = `<div class="result-heading"><span>OUTPUT</span><span>Input error</span></div>${renderError(parsed, 'validation')}`;
    status.textContent = 'Needs attention';
    calculationHistory.push({
      input: input.value,
      summary: null,
      error: parsed.message,
      errorCode: parsed.code,
      errorCategory: 'validation',
      timestamp: Date.now()
    });
    return;
  }

  button.disabled = true;
  runTool.disabled = true;
  button.textContent = 'Running…';
  result.className = 'result-panel loading';
  result.innerHTML = '<div class="result-heading"><span>OUTPUT</span><span>Processing…</span></div><p>Sending samples to the native C engine…</p>';
  status.textContent = 'Processing';

  try {
    const summarize = getSummarizeFunction();
    if (!summarize) {
      throw new Error('The native WebView bridge is unavailable. Run the desktop app to calculate metrics.');
    }

    const summary = await summarize(parsed.values);

    if (summary.error) {
      const category = getErrorCategory(summary);
      throw { original: summary, category };
    }

    result.className = 'result-panel';
    result.innerHTML = '<div class="result-heading"><span>OUTPUT</span><span>Complete</span></div>' + renderSummary(summary);
    status.textContent = 'Saved result';
    
    calculationHistory.push({
      input: input.value,
      summary,
      error: null,
      errorCode: null,
      errorCategory: null,
      timestamp: Date.now()
    });
  } catch (error) {
    const category = (error && typeof error === 'object' && 'category' in error)
      ? (error as { category: string }).category
      : getErrorCategory(error);
    const errorMsg = (error && typeof error === 'object' && 'original' in error)
      ? getErrorMessage((error as { original: unknown }).original)
      : getErrorMessage(error);

    result.className = 'result-panel error';
    result.innerHTML = `<div class="result-heading"><span>OUTPUT</span><span>Bridge error</span></div>${renderError(errorMsg, category)}`;
    status.textContent = 'Failed';
    
    calculationHistory.push({
      input: input.value,
      summary: null,
      error: errorMsg,
      errorCode: category,
      errorCategory: category,
      timestamp: Date.now()
    });
  } finally {
    button.disabled = false;
    runTool.disabled = false;
    button.textContent = 'Run metrics';
  }
}

function getSummarizeFunction(): ((values: number[]) => Promise<Record<string, unknown>>) | null {
  if (typeof window.summarize === 'function') {
    return window.summarize;
  }
  
  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return (values: number[]) => window.__webview__.call('summarize', values);
  }
  
  return null;
}

function setActiveTool(toolId: string) {
  document.querySelectorAll('.rail-button').forEach(btn => btn.classList.remove('active'));
  const tool = document.getElementById(toolId);
  if (tool) tool.classList.add('active');
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
        <button class="toolbar-button subtle" id="new-document" type="button" onclick={() => { clearDocument(); setActiveTool('tool-clear'); }}>New</button>
        <button class="toolbar-button subtle" id="copy-result" type="button" onclick={() => copyResult()}>Copy</button>
        <button class="toolbar-button subtle" id="export-history" type="button" onclick={() => exportHistory()}>Export</button>
        <button class="toolbar-button primary" id="calculate" type="button" onclick={() => { calculate(); setActiveTool('tool-run'); }}>Run metrics</button>
      </div>
    </header>

    <div class="editor-layout">
      <section class="editor-pane" aria-label="Text editor">
        <div class="editor-meta">
          <span>INPUT</span>
          <span id="cursor-position">Line 1, Col 1</span>
        </div>
        <label class="sr-only" for="values">Document text</label>
        <textarea id="values" spellcheck="false" aria-describedby="editor-help" oninput={() => { updateCursorPosition(); updateInputStats(); }} onclick={() => updateCursorPosition()} onkeyup={() => updateCursorPosition()} onkeydown={(e) => handleEditorKeydown(e)}>12.5, 15, 8.5, 14</textarea>
        <div class="editor-footer">
          <span id="editor-help">Comma-separated numbers are sent to the native C engine.</span>
          <span id="document-status">Ready</span>
        </div>
      </section>

      <aside class="right-toolbar" aria-label="Editor tools">
        <button class="rail-button active" id="tool-edit" type="button" aria-label="Edit document" title="Edit document" onclick={() => { setActiveTool('tool-edit'); document.getElementById('values')?.focus(); }}><span aria-hidden="true">✎</span></button>
        <button class="rail-button" id="tool-run" type="button" aria-label="Run metrics" title="Run metrics" onclick={() => { calculate(); setActiveTool('tool-run'); }}><span aria-hidden="true">▶</span></button>
        <button class="rail-button" id="tool-clear" type="button" aria-label="Clear document" title="Clear document" onclick={() => { clearDocument(); setActiveTool('tool-clear'); }}><span aria-hidden="true">⌫</span></button>
        <div class="rail-spacer"></div>
        <button class="rail-button" id="tool-info" type="button" aria-label="Show help" title="Show help" onclick={() => { showHelp(); setActiveTool('tool-info'); }}><span aria-hidden="true">?</span></button>
      </aside>
    </div>

    <section id="result" class="result-panel" aria-live="polite" aria-label="Metrics result">
      <div class="result-heading"><span>OUTPUT</span><span>No result yet</span></div>
      <p class="placeholder">Run metrics to inspect the native calculation.</p>
    </section>
  </main>
}
