import './App.css';
import { getErrorMessage, parseValues, renderSummary } from './metrics-ui.js';

const rootEl = document.getElementById('root');
if (rootEl && document.getElementById('calculate')) {
  const input = document.getElementById('values');
  const result = document.getElementById('result');
  const button = document.getElementById('calculate');

  async function calculate() {
    const parsed = parseValues(input.value);
    if (!parsed.ok) {
      result.textContent = parsed.message;
      result.className = 'result error';
      return;
    }

    button.disabled = true;
    button.textContent = 'Calculating…';
    result.className = 'result loading';
    result.textContent = 'Sending samples to the native C engine…';

    try {
      const summarize =
        typeof window.summarize === 'function'
          ? window.summarize
          : window.__webview__ && typeof window.__webview__.call === 'function'
            ? (values) => window.__webview__.call('summarize', values)
            : null;
      if (!summarize) {
        throw new Error(
          'The native WebView bridge is unavailable. Run the desktop app to calculate metrics.',
        );
      }
      const summary = await summarize(parsed.values);
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

  button.addEventListener('click', calculate);
}
