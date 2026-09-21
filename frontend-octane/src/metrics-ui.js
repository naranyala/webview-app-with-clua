export function parseValues(raw) {
  const tokens = raw.split(',').map((value) => value.trim());
  const values = tokens.map((value) => Number(value));

  if (
    tokens.length === 0 ||
    tokens.some(
      (value, index) => value === '' || !Number.isFinite(values[index]),
    )
  ) {
    return {
      ok: false,
      message: 'Enter one or more finite numbers separated by commas.',
    };
  }

  return { ok: true, values };
}

export function formatNumber(value) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

export function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') {
    try {
      return getErrorMessage(JSON.parse(error));
    } catch {
      return error;
    }
  }
  if (error && typeof error === 'object') {
    if (error.error) return getErrorMessage(error.error);
    if (error.message) return error.message;
  }
  return String(error);
}

export function renderSummary(summary) {
  return `
    <div class="summary-grid">
      <div><span>Samples</span><strong>${summary.count}</strong></div>
      <div><span>Sum</span><strong>${formatNumber(summary.sum)}</strong></div>
      <div><span>Mean</span><strong>${formatNumber(summary.mean)}</strong></div>
      <div><span>Variance</span><strong>${formatNumber(summary.variance)}</strong></div>
      <div><span>Minimum</span><strong>${formatNumber(summary.min)}</strong></div>
      <div><span>Maximum</span><strong>${formatNumber(summary.max)}</strong></div>
    </div>`;
}
