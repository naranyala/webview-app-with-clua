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
      message:
        'Enter one or more finite numbers separated by commas or newlines.',
      code: 'EMPTY_INPUT',
    };
  }
  const tokens = trimmed.split(/[,\n]+/).map((value) => value.trim());
  const values = tokens.map((value) => Number(value));
  const emptyTokens = tokens.filter((value) => value === '');
  if (emptyTokens.length > 0) {
    return {
      ok: false,
      message: `Found ${emptyTokens.length} empty token${emptyTokens.length > 1 ? 's' : ''}. Each comma or newline should separate two numbers.`,
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
  if (typeof value !== 'number' || !Number.isFinite(value))
    return String(value);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

export function formatNumberWithCommas(value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return String(value);
  const parts = formatNumber(value).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

export function extractBridgeError(response) {
  if (response && typeof response === 'object' && response.error) {
    const error = response.error;
    return {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || 'An unknown error occurred.',
      raw: error,
    };
  }
  return null;
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
    const extracted = extractBridgeError(error);
    if (extracted) return `[${extracted.code}] ${extracted.message}`;
    if (error.message) return error.message;
  }
  return String(error);
}

export function getErrorCategory(error) {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('bridge is unavailable')) return 'bridge_unavailable';
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('network') || message.includes('fetch'))
      return 'network';
  }
  if (typeof error === 'string') {
    try {
      return getErrorCategory(JSON.parse(error));
    } catch {
      return 'unknown';
    }
  }
  if (error && typeof error === 'object' && error.error) {
    const extracted = extractBridgeError(error);
    if (extracted) {
      if (
        ['EMPTY_INPUT', 'INVALID_REQUEST', 'INVALID_VALUE'].includes(
          extracted.code,
        )
      ) {
        return 'validation';
      }
      return 'backend';
    }
  }
  return 'unknown';
}

export function getErrorHelp(category) {
  switch (category) {
    case 'bridge_unavailable':
      return 'This feature requires the desktop application. Build and run with "make desktop".';
    case 'validation':
      return 'Check your input: only finite numbers separated by commas or newlines are accepted.';
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

export function validateInput(raw) {
  const tokens = raw.split(/[,\n]+/).map((value) => value.trim());
  const values = tokens.map((value) => Number(value));
  const stats = { total: tokens.length, valid: 0, invalid: 0, empty: 0 };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '') stats.empty += 1;
    else if (Number.isFinite(values[index])) stats.valid += 1;
    else stats.invalid += 1;
  }
  return stats;
}
