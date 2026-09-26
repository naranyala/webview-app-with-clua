import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNumber,
  getErrorCategory,
  getErrorMessage,
  parseValues,
  validateInput,
} from '../src/metrics-ui.js';

test('parseValues accepts comma and newline separated finite numbers', () => {
  const result = parseValues(' +1.5, -2.5\n3e2, 4 ');
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [1.5, -2.5, 300, 4]);
  assert.equal(result.code, 'OK');
});

test('parseValues rejects empty and invalid input', () => {
  for (const input of ['', 'Infinity', 'NaN', 'nope']) {
    assert.equal(parseValues(input).ok, false, input);
  }
  assert.match(parseValues('1, nope').message, /Invalid number/);
});

test('parseValues enforces the native size limit', () => {
  const result = parseValues(
    Array.from({ length: 10001 }, (_, i) => i).join(','),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_MANY_VALUES');
});

test('number formatting keeps useful precision', () => {
  assert.equal(formatNumber(2.666666666), '2.6667');
  assert.equal(formatNumber(12.5), '12.5');
});

test('bridge errors include their code and category', () => {
  const payload = {
    error: { code: 'INVALID_VALUE', message: 'Finite values only.' },
  };
  assert.equal(getErrorMessage(payload), '[INVALID_VALUE] Finite values only.');
  assert.equal(getErrorCategory(payload), 'validation');
});

test('validateInput reports token classes', () => {
  assert.deepEqual(validateInput('1, nope, '), {
    total: 3,
    valid: 1,
    invalid: 1,
    empty: 1,
  });
});
