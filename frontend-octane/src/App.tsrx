import { useState } from 'octane';
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

interface PdfHeading {
  page: number;
  level: number;
  position: number;
  title: string;
}

const calculationHistory: CalculationHistory[] = [];
let currentPdfUrl = '';

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

function getOpenPdfFunction(): (() => Promise<Record<string, unknown>>) | null {
  if (typeof window.openPdf === 'function') return window.openPdf;

  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return () => window.__webview__.call('openPdf');
  }

  return null;
}

function getExtractPdfTocFunction(): (() => Promise<Record<string, unknown>>) | null {
  if (typeof window.extractPdfToc === 'function') return window.extractPdfToc;

  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return () => window.__webview__.call('extractPdfToc');
  }

  return null;
}

function setPdfStatus(message: string, isError = false) {
  const status = document.getElementById('pdf-status');
  if (!status) return;
  status.textContent = message;
  status.className = isError ? 'pdf-status error' : 'pdf-status';
}

function setTocMessage(message: string, state = '') {
  const panel = document.getElementById('toc-panel');
  if (!panel) return;
  panel.dataset.state = state;
  const messageElement = document.createElement('p');
  messageElement.className = 'toc-message';
  messageElement.textContent = message;
  panel.replaceChildren(messageElement);
}

function navigateToPage(page: number) {
  const viewer = document.getElementById('pdf-viewer') as HTMLObjectElement | null;
  if (!viewer || !currentPdfUrl) return;
  const baseUrl = currentPdfUrl.split('#')[0];
  viewer.data = `${baseUrl}#page=${page}`;

  for (const button of document.querySelectorAll('.toc-item')) {
    button.classList.toggle('active', Number(button.dataset.page) === page);
  }
}

function renderPdfToc(headings: PdfHeading[], cached: boolean) {
  const panel = document.getElementById('toc-panel');
  const count = document.getElementById('toc-count');
  if (!panel) return;

  if (count) count.textContent = `${headings.length} heading${headings.length === 1 ? '' : 's'}`;
  panel.dataset.state = 'ready';
  panel.replaceChildren();

  for (const heading of headings) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toc-item';
    button.dataset.page = String(heading.page);
    button.style.setProperty('--toc-level', String(Math.max(1, Math.min(heading.level, 3))));
    button.textContent = heading.title;
    button.title = `Page ${heading.page}${cached ? ' · saved TOC' : ''}`;
    button.addEventListener('click', () => navigateToPage(heading.page));
    panel.append(button);
  }
}

async function loadPdfToc() {
  const extractToc = getExtractPdfTocFunction();
  if (!extractToc) {
    setTocMessage('TOC extraction is available in the desktop app.');
    return;
  }

  setTocMessage('Extracting headings and checking saved TOC…', 'loading');
  try {
    const result = await extractToc();
    if (result.error) {
      const error = result.error as { message?: string };
      setTocMessage(error.message || 'Could not extract headings from this PDF.', 'error');
      return;
    }
    const headings = Array.isArray(result.headings) ? result.headings as PdfHeading[] : [];
    if (headings.length === 0) {
      setTocMessage('No headings were detected in this document.', 'empty');
      return;
    }
    renderPdfToc(headings, Boolean(result.cached));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not extract headings from this PDF.';
    setTocMessage(message, 'error');
  }
}

function setPdfDocument(name: string, size: number, url: string) {
  const nameElement = document.getElementById('pdf-name');
  const empty = document.getElementById('pdf-empty');
  const viewer = document.getElementById('pdf-viewer') as HTMLObjectElement | null;
  if (!nameElement || !viewer) return;

  currentPdfUrl = url;
  nameElement.textContent = name;
  empty?.setAttribute('hidden', '');
  viewer.data = url;
  viewer.hidden = false;
  setPdfStatus(`${name} · ${(size / 1024 / 1024).toFixed(2)} MB`);
}

function selectLocalPdf() {
  document.getElementById('pdf-file-input')?.click();
}

function handlePdfFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  if (file.type && file.type !== 'application/pdf') {
    setPdfStatus('The selected file is not a PDF.', true);
    return;
  }

  const previousUrl = document.getElementById('pdf-viewer')?.getAttribute('data') || '';
  if (previousUrl.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
  setPdfDocument(file.name, file.size, URL.createObjectURL(file));
  loadPdfToc();
}

async function openPdf() {
  const openPdfFile = getOpenPdfFunction();
  if (!openPdfFile) {
    selectLocalPdf();
    return;
  }

  setPdfStatus('Waiting for the system file picker…');
  try {
    const opened = await openPdfFile();
    if (opened.error) {
      const error = opened.error as { message?: string };
      setPdfStatus(error.message || 'Could not open the PDF.', true);
      return;
    }

    if (opened.canceled) {
      setPdfStatus('PDF selection was cancelled.');
      return;
    }

    const name = String(opened.name || 'document.pdf');
    const size = Number(opened.size || 0);
    const url = String(opened.url || '');
    if (!url) {
      setPdfStatus('The selected PDF did not provide a readable URL.', true);
      return;
    }
    setPdfDocument(name, size, url);
    loadPdfToc();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not open the PDF.';
    setPdfStatus(message || 'PDF selection was cancelled.', true);
  }
}

export function App() @{
  const [view, setView] = useState<'menu' | 'editor' | 'pdf'>('menu');
  const selectView = (nextView: 'menu' | 'editor' | 'pdf') => {
    setView(nextView);
    if (nextView === 'editor') {
      requestAnimationFrame(() => document.getElementById('values')?.focus());
    }
  };
  <main class="app-shell">
    <header class="launcher-header">
      <div class="brand">
        <span class="brand-mark">N</span>
        <div>
          <span class="brand-name">Native Workspace</span>
          <span class="brand-subtitle">Local tools, one workspace</span>
        </div>
      </div>
      <button class="toolbar-button subtle" id="back-to-menu" type="button" onClick={() => selectView('menu')}>All apps</button>
    </header>

    <section class="app-menu" data-view="menu" aria-label="Application menu" hidden={view !== 'menu'}>
      <div class="menu-heading">
        <span>APPLICATIONS</span>
        <h1>What would you like to open?</h1>
        <p>Choose a local tool to get started.</p>
      </div>
      <div class="app-grid">
        <button class={`app-card ${view === 'editor' ? 'active' : ''}`} data-app="editor" type="button" onClick={() => selectView('editor')}>
          <span class="app-icon text-icon" aria-hidden="true">Aa</span>
          <span class="app-card-copy"><strong>Text Editor</strong><small>Edit text and run native metrics</small></span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class={`app-card ${view === 'pdf' ? 'active' : ''}`} data-app="pdf" type="button" onClick={() => selectView('pdf')}>
          <span class="app-icon pdf-icon" aria-hidden="true">PDF</span>
          <span class="app-card-copy"><strong>PDF Reader</strong><small>Open a PDF from your local system</small></span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
      </div>
    </section>

    <section class="editor-app" data-view="editor" aria-label="Text editor application" hidden={view !== 'editor'}>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">N</span>
          <span class="brand-name">Plaintext</span>
        </div>
        <div class="document-title" aria-live="polite">untitled.txt</div>
        <div class="top-actions">
          <button class="toolbar-button subtle" id="new-document" type="button" onClick={() => { clearDocument(); setActiveTool('tool-clear'); }}>New</button>
          <button class="toolbar-button subtle" id="copy-result" type="button" onClick={() => copyResult()}>Copy</button>
          <button class="toolbar-button subtle" id="export-history" type="button" onClick={() => exportHistory()}>Export</button>
          <button class="toolbar-button primary" id="calculate" type="button" onClick={() => { calculate(); setActiveTool('tool-run'); }}>Run metrics</button>
        </div>
      </header>

      <div class="editor-layout">
        <section class="editor-pane" aria-label="Text editor">
          <div class="editor-meta">
            <span>INPUT</span>
            <span id="cursor-position">Line 1, Col 1</span>
          </div>
          <label class="sr-only" for="values">Document text</label>
          <textarea id="values" spellcheck="false" aria-describedby="editor-help" onInput={() => { updateCursorPosition(); updateInputStats(); }} onClick={() => updateCursorPosition()} onKeyUp={() => updateCursorPosition()} onKeyDown={(e) => handleEditorKeydown(e)}>12.5, 15, 8.5, 14</textarea>
          <div class="editor-footer">
            <span id="editor-help">Comma-separated numbers are sent to the native C engine.</span>
            <span id="document-status">Ready</span>
          </div>
        </section>

        <aside class="right-toolbar" aria-label="Editor tools">
          <button class="rail-button active" id="tool-edit" type="button" aria-label="Edit document" title="Edit document" onClick={() => { setActiveTool('tool-edit'); document.getElementById('values')?.focus(); }}><span aria-hidden="true">✎</span></button>
          <button class="rail-button" id="tool-run" type="button" aria-label="Run metrics" title="Run metrics" onClick={() => { calculate(); setActiveTool('tool-run'); }}><span aria-hidden="true">▶</span></button>
          <button class="rail-button" id="tool-clear" type="button" aria-label="Clear document" title="Clear document" onClick={() => { clearDocument(); setActiveTool('tool-clear'); }}><span aria-hidden="true">⌫</span></button>
          <div class="rail-spacer"></div>
          <button class="rail-button" id="tool-info" type="button" aria-label="Show help" title="Show help" onClick={() => { showHelp(); setActiveTool('tool-info'); }}><span aria-hidden="true">?</span></button>
        </aside>
      </div>

      <section id="result" class="result-panel" aria-live="polite" aria-label="Metrics result">
        <div class="result-heading"><span>OUTPUT</span><span>No result yet</span></div>
        <p class="placeholder">Run metrics to inspect the native calculation.</p>
      </section>
    </section>

    <section class="pdf-app" data-view="pdf" aria-label="PDF reader application" hidden={view !== 'pdf'}>
      <header class="pdf-toolbar">
        <div>
          <span class="pdf-eyebrow">PDF READER</span>
          <strong id="pdf-name">No document selected</strong>
        </div>
        <div class="pdf-actions">
          <span id="pdf-status" class="pdf-status" aria-live="polite">Choose a PDF from your system to begin reading.</span>
          <button class="toolbar-button primary" id="open-pdf" type="button" onClick={() => openPdf()}>Open PDF</button>
        </div>
      </header>
      <aside class="toc-sidebar" aria-label="Document table of contents">
        <div class="toc-heading">
          <span>CONTENTS</span>
          <strong id="toc-count">No headings yet</strong>
        </div>
        <nav id="toc-panel" class="toc-panel" aria-live="polite">
          <p class="toc-message">Open a PDF to build its table of contents.</p>
        </nav>
      </aside>
      <div class="pdf-content">
        <input id="pdf-file-input" class="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => handlePdfFile(event)} />
        <div class="pdf-empty" id="pdf-empty">
          <span class="pdf-large-icon" aria-hidden="true">PDF</span>
          <h2>Read a local PDF</h2>
          <p>Use the system file picker to securely open a document from this computer.</p>
          <button class="toolbar-button primary" id="browse-pdf" type="button" onClick={() => openPdf()}>Browse files</button>
        </div>
        <object id="pdf-viewer" class="pdf-viewer" type="application/pdf" aria-label="Selected PDF document" hidden>
          <p>Your system cannot display this PDF.</p>
        </object>
      </div>
    </section>
  </main>
}
