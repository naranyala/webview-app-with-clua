import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNumber,
  getErrorMessage,
  parseValues,
  renderSummary,
} from '../src/metrics-ui.js';

test('parseValues accepts signed decimals and exponents', () => {
  assert.deepEqual(parseValues(' +1.5, -2.5, 3e2 '), {
    ok: true,
    values: [1.5, -2.5, 300],
  });
});

test('parseValues rejects empty and malformed tokens', () => {
  for (const input of ['', '1,,2', '1, nope', 'Infinity', 'NaN']) {
    const result = parseValues(input);
    assert.equal(result.ok, false, input);
    assert.match(result.message, /finite numbers/);
  }
});

test('formatNumber keeps useful precision without trailing zeroes', () => {
  assert.equal(formatNumber(4), '4');
  assert.equal(formatNumber(2.666666666), '2.6667');
  assert.equal(formatNumber(12.5), '12.5');
});

test('getErrorMessage decodes native bridge errors', () => {
  const payload = {
    error: { code: 'INVALID_VALUE', message: 'Finite values only.' },
  };
  assert.equal(getErrorMessage(payload), 'Finite values only.');
  assert.equal(getErrorMessage(JSON.stringify(payload)), 'Finite values only.');
  assert.equal(
    getErrorMessage(new Error('Bridge unavailable.')),
    'Bridge unavailable.',
  );
  assert.equal(getErrorMessage('plain failure'), 'plain failure');
});

test('renderSummary includes every native metric', () => {
  const html = renderSummary({
    count: 3,
    sum: 9,
    min: 1,
    max: 5,
    mean: 3,
    variance: 8 / 3,
  });
  for (const label of [
    'Samples',
    'Sum',
    'Mean',
    'Variance',
    'Minimum',
    'Maximum',
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, />3</);
  assert.match(html, />2\.6667</);
});
