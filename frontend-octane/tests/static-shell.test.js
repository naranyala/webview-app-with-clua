import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const shell = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8',
);
const component = readFileSync(
  new URL('../src/App.tsrx', import.meta.url),
  'utf8',
);

test('static WebView shell and Octane component share the editor contract', () => {
  assert.match(shell, /id="root"/, 'shell is missing #root');
  for (const id of [
    'values',
    'calculate',
    'new-document',
    'copy-result',
    'tool-run',
    'tool-clear',
    'tool-info',
    'result',
  ]) {
    assert.match(
      component,
      new RegExp(`id="${id}"`),
      `component is missing #${id}`,
    );
    assert.match(shell, new RegExp(`id="${id}"`), `shell is missing #${id}`);
  }

  for (const text of ['Run metrics', 'Copy', '12.5, 15, 8.5, 14']) {
    assert.match(
      shell,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(
      component,
      new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
});
