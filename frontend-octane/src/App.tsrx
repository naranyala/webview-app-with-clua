import './App.css';
import { getErrorMessage, parseValues, renderSummary } from './metrics-ui.js';

type BridgeError = {
  code: string;
  message: string;
};

type Summary = {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  variance: number;
  error?: BridgeError | string;
};

declare global {
  interface Window {
    summarize: (values: number[]) => Promise<Summary>;
  }
}

async function calculate() {
  const input = document.getElementById('values') as HTMLTextAreaElement;
  const result = document.getElementById('result');
  const button = document.getElementById('calculate') as HTMLButtonElement;

  if (!input || !result || !button) return;

  const parsed = parseValues(input.value);
  if (!parsed.ok) {
    result.textContent = parsed.message;
    result.className = 'result error';
    return;
  }
  const values = parsed.values;

  button.disabled = true;
  button.textContent = 'Calculating…';
  result.className = 'result loading';
  result.textContent = 'Sending samples to the native C engine…';

  try {
    if (typeof window.summarize !== 'function') {
      throw new Error('The native WebView bridge is unavailable. Run the desktop app to calculate metrics.');
    }
    const summary = await window.summarize(values);
    if (summary.error) throw new Error(getErrorMessage(summary.error));

    result.className = 'result';
    result.innerHTML = renderSummary(summary);
  } catch (error) {
    result.className = 'result error';
    result.textContent = getErrorMessage(error);
  } finally {
    button.disabled = false;
    button.textContent = 'Calculate metrics';
  }
}

export function App() @{
  <main class="card">
    <div class="eyebrow">C + WebView + Octane</div>
    <h1>Batch metrics</h1>
    <p class="intro">Enter comma-separated numbers. Octane sends them through WebView’s JavaScript bridge to the native C engine.</p>
    <label for="values">Samples</label>
    <textarea id="values" spellcheck="false">12.5, 15, 8.5, 14</textarea>
    <button id="calculate" type="button" onclick={calculate}>Calculate metrics</button>
    <section id="result" class="result" aria-live="polite">
      <p class="placeholder">Your summary will appear here.</p>
    </section>
    <p class="hint">The native engine validates finite values and calculates count, sum, mean, range, and variance.</p>
  </main>
}
