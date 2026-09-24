export function parseValues(raw) {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      message: 'Input must be a string.',
      code: 'INVALID_TYPE',
    };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      ok: false,
      message: 'Enter one or more finite numbers separated by commas.',
      code: 'EMPTY_INPUT',
    };
  }

  const tokens = trimmed.split(',').map((value) => value.trim());
  const values = tokens.map((value) => Number(value));

  const emptyTokens = tokens.filter((value) => value === '');
  if (emptyTokens.length > 0) {
    return {
      ok: false,
      message: `Found ${emptyTokens.length} empty token${emptyTokens.length > 1 ? 's' : ''}. Each comma should separate two numbers.`,
      code: 'EMPTY_TOKENS',
    };
  }

  const invalidTokens = tokens.filter(
    (_value, index) => !Number.isFinite(values[index]),
  );
  if (invalidTokens.length > 0) {
    const shown = invalidTokens.slice(0, 3).join(', ');
    const suffix =
      invalidTokens.length > 3 ? ` (and ${invalidTokens.length - 3} more)` : '';
    return {
      ok: false,
      message: `Invalid number${invalidTokens.length > 1 ? 's' : ''}: ${shown}${suffix}`,
      code: 'INVALID_NUMBER',
    };
  }

  if (values.length > 10000) {
    return {
      ok: false,
      message: `Too many values (${values.length}). Maximum supported is 10,000.`,
      code: 'TOO_MANY_VALUES',
    };
  }

  return { ok: true, values, code: 'OK' };
}

export function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  const formatted = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return formatted || '0';
}

export function formatNumberWithCommas(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }
  const parts = formatNumber(value).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

export function extractBridgeError(response) {
  if (response && typeof response === 'object' && response.error) {
    const err = response.error;
    return {
      code: err.code || 'UNKNOWN_ERROR',
      message: err.message || 'An unknown error occurred.',
      raw: err,
    };
  }
  return null;
}

export function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      const extracted = extractBridgeError(parsed);
      if (extracted) return `[${extracted.code}] ${extracted.message}`;
      return getErrorMessage(parsed);
    } catch {
      return error;
    }
  }
  if (error && typeof error === 'object') {
    const extracted = extractBridgeError(error);
    if (extracted) return `[${extracted.code}] ${extracted.message}`;
    if (error.message) return error.message;
  }
  return String(error);
}

export function getErrorCategory(error) {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('bridge is unavailable')) return 'bridge_unavailable';
    if (msg.includes('timeout')) return 'timeout';
    if (msg.includes('network') || msg.includes('fetch')) return 'network';
  }
  if (typeof error === 'string') {
    try {
      return getErrorCategory(JSON.parse(error));
    } catch {
      return 'unknown';
    }
  }
  if (error && typeof error === 'object') {
    if (error.error) {
      const extracted = extractBridgeError(error);
      if (extracted) {
        switch (extracted.code) {
          case 'EMPTY_INPUT':
            return 'validation';
          case 'INVALID_REQUEST':
            return 'validation';
          case 'INVALID_VALUE':
            return 'validation';
          case 'OUT_OF_MEMORY':
            return 'backend';
          case 'BUFFER_TOO_SMALL':
            return 'backend';
          case 'ENGINE_FAILED':
            return 'backend';
          case 'INTERNAL_ERROR':
            return 'backend';
          case 'NULL_REQUEST':
            return 'backend';
          default:
            return 'backend';
        }
      }
    }
  }
  return 'unknown';
}

export function getErrorHelp(category) {
  switch (category) {
    case 'bridge_unavailable':
      return 'This feature requires the desktop application. Build and run with "make desktop".';
    case 'validation':
      return 'Check your input: only finite numbers separated by commas are accepted.';
    case 'backend':
      return 'The native engine encountered an internal error. Try with fewer or simpler values.';
    case 'network':
      return 'A network error occurred. Check your connection and try again.';
    case 'timeout':
      return 'The operation timed out. Try with fewer values.';
    default:
      return 'An unexpected error occurred. Try reloading the page.';
  }
}

export function renderSummary(summary) {
  const timestamp = new Date().toLocaleTimeString();
  return `
    <div class="summary-grid">
      <div><span>Samples</span><strong class="summary-value">${summary.count}</strong></div>
      <div><span>Sum</span><strong class="summary-value">${formatNumberWithCommas(summary.sum)}</strong></div>
      <div><span>Mean</span><strong class="summary-value">${formatNumberWithCommas(summary.mean)}</strong></div>
      <div><span>Variance</span><strong class="summary-value">${formatNumberWithCommas(summary.variance)}</strong></div>
      <div><span>Minimum</span><strong class="summary-value">${formatNumberWithCommas(summary.min)}</strong></div>
      <div><span>Maximum</span><strong class="summary-value">${formatNumberWithCommas(summary.max)}</strong></div>
    </div>
    <div class="timestamp">Calculated at ${timestamp}</div>`;
}

export function renderError(error, category) {
  const help = getErrorHelp(category);
  const errorMsg = getErrorMessage(error);
  return `
    <div class="error-details">
      <p class="error-message">${errorMsg}</p>
      <p class="error-help">${help}</p>
    </div>`;
}

export function validateInput(raw) {
  const tokens = raw.split(',').map((value) => value.trim());
  const values = tokens.map((value) => Number(value));

  const stats = {
    total: tokens.length,
    valid: 0,
    invalid: 0,
    empty: 0,
  };

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '') {
      stats.empty++;
    } else if (Number.isFinite(values[i])) {
      stats.valid++;
    } else {
      stats.invalid++;
    }
  }

  return stats;
}
