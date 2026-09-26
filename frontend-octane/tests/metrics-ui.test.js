import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatNumber,
  getErrorMessage,
  parseValues,
  renderSummary,
} from '../src/metrics-ui.js';

test('parseValues accepts signed decimals and exponents', () => {
  const result = parseValues(' +1.5, -2.5, 3e2 ');
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [1.5, -2.5, 300]);
  assert.equal(result.code, 'OK');
});

test('parseValues rejects empty and malformed tokens', () => {
  for (const input of ['', 'Infinity', 'NaN']) {
    const result = parseValues(input);
    assert.equal(result.ok, false, input);
  }
  const nopeResult = parseValues('1, nope');
  assert.equal(nopeResult.ok, false);
  assert.match(nopeResult.message, /Invalid number/);
});

test('parseValues treats multiple consecutive commas as one separator', () => {
  const result = parseValues('1,,2');
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [1, 2]);
});

test('parseValues accepts newline-separated input', () => {
  const input = '1\n2\n3';
  const result = parseValues(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [1, 2, 3]);
});

test('parseValues accepts mixed comma and newline separators', () => {
  const input = '1, 2\n3, 4\n5';
  const result = parseValues(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.values, [1, 2, 3, 4, 5]);
});

test('parseValues rejects trailing newlines as empty tokens', () => {
  const input = '1, 2,';
  const result = parseValues(input);
  assert.equal(result.ok, false);
  assert.match(result.message, /empty token/);
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
  assert.equal(getErrorMessage(payload), '[INVALID_VALUE] Finite values only.');
  assert.equal(
    getErrorMessage(JSON.stringify(payload)),
    '[INVALID_VALUE] Finite values only.',
  );
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
