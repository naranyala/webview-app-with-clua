/*
 * Unit tests for the shared file transfer layer: suggested export names,
 * the native-first branches for openTextFile/saveTextFile, and the browser
 * fallbacks (anchor download, FileReader) used when the host is absent.
 */

import assert from 'node:assert/strict';
import test, { after, describe } from 'node:test';

import {
  readFileAsText,
  readTextFileNative,
  suggestFileName,
  withFileTransfer,
  withTextFileRead,
  withTextFileWrite,
  writeTextFile,
} from '../src/file-io.js';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalFileReader = globalThis.FileReader;

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalFileReader === undefined) delete globalThis.FileReader;
  else globalThis.FileReader = originalFileReader;
});

test('suggestFileName sanitizes, caps, and extends names', () => {
  assert.equal(suggestFileName('Chapter One'), 'Chapter One.txt');
  assert.equal(suggestFileName('notes'), 'notes.txt');
  assert.equal(suggestFileName('a/b\\c:d'), 'a b c d.txt');
  assert.equal(suggestFileName('My Doc...'), 'My Doc.txt');
  assert.equal(suggestFileName(''), 'document.txt');
  assert.equal(suggestFileName(' . '), 'document.txt');
  assert.equal(suggestFileName(null), 'document.txt');
  assert.equal(suggestFileName('report.txt'), 'report.txt');
  assert.equal(suggestFileName('outline', 'json', 'export'), 'outline.json');

  // The byte cap counts code points, never splits a surrogate pair, and
  // always leaves room for the extension inside the native 60-byte cap.
  const name = suggestFileName('😀'.repeat(100));
  assert.ok(name.endsWith('.txt'));
  assert.equal([...name.slice(0, -4)].length, 12);
  assert.ok(new TextEncoder().encode(name).length <= 60);
});

test('readTextFileNative is null without the host', async () => {
  globalThis.window = {};
  assert.equal(await readTextFileNative(), null);
});

test('readTextFileNative normalizes host results', async () => {
  globalThis.window = {
    openTextFile: async () => ({
      name: 'notes.md',
      path: '/tmp/notes.md',
      content: 'draft body',
    }),
  };
  assert.deepEqual(await readTextFileNative(), {
    name: 'notes.md',
    path: '/tmp/notes.md',
    content: 'draft body',
  });

  globalThis.window = { openTextFile: async () => ({ canceled: true }) };
  assert.deepEqual(await readTextFileNative(), { canceled: true });

  const hostError = { error: { code: 'READ_FAILED', message: 'nope' } };
  globalThis.window = { openTextFile: async () => hostError };
  assert.deepEqual(await readTextFileNative(), hostError);
});

test('writeTextFile passes name and content to the host', async () => {
  const calls = [];
  globalThis.window = {
    saveTextFile: async (...args) => {
      calls.push(args);
      return { name: 'outline.json', path: '/tmp/outline.json', bytes: 12 };
    },
  };
  const saved = await writeTextFile('outline.json', '{"a":1}');
  assert.deepEqual(calls, [['outline.json', '{"a":1}']]);
  assert.deepEqual(saved, {
    name: 'outline.json',
    path: '/tmp/outline.json',
    bytes: 12,
  });

  globalThis.window = { saveTextFile: async () => ({ canceled: true }) };
  assert.deepEqual(await writeTextFile('a', 'b'), { canceled: true });

  const hostError = { error: { code: 'WRITE_FAILED', message: 'disk full' } };
  globalThis.window = { saveTextFile: async () => hostError };
  assert.deepEqual(await writeTextFile('a', 'b'), hostError);
});

test('writeTextFile falls back to a download outside the host', async () => {
  const anchors = [];
  globalThis.window = {};
  globalThis.document = {
    createElement: () => {
      const anchor = {
        href: '',
        download: '',
        clicked: false,
        click() {
          this.clicked = true;
        },
      };
      anchors.push(anchor);
      return anchor;
    },
  };

  const result = await writeTextFile('notes.txt', 'hello');
  assert.equal(result.name, 'notes.txt');
  assert.equal(result.bytes, 5);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].download, 'notes.txt');
  assert.ok(anchors[0].clicked);
});

test('readFileAsText resolves, rejects, and reports reader failures', async () => {
  globalThis.FileReader = class {
    readAsText(file) {
      this.result = file.__text;
      this.onload();
    }
  };
  assert.equal(await readFileAsText({ __text: 'body text' }), 'body text');
  await assert.rejects(readFileAsText(null), /No file was chosen/);

  /* A File that exposes text() never needs FileReader at all. */
  assert.equal(
    await readFileAsText({ text: async () => 'modern path' }),
    'modern path',
  );
  await assert.rejects(
    readFileAsText({
      text: async () => {
        throw new Error('nope');
      },
    }),
    /nope/,
  );

  globalThis.FileReader = class {
    readAsText() {
      this.error = new Error('boom');
      this.onerror();
    }
  };
  await assert.rejects(readFileAsText({}), /boom/);
});

/*
 * The transfer pipeline: one place that knows the three outcomes every
 * transfer has. The tests assert the status codes rather than the wording, so
 * a message can change without rewriting them.
 */
describe('withFileTransfer', () => {
  const collect = () => {
    const lines = [];
    return {
      lines,
      report: (message, isError = false) => lines.push({ message, isError }),
    };
  };

  test('a success reports done and hands the value to handle', async () => {
    const { lines, report } = collect();
    const outcome = await withFileTransfer(
      () => Promise.resolve({ path: '/tmp/a.txt' }),
      {
        report,
        messages: { pending: 'Working…', done: 'Saved.' },
        handle: (value) => `handled ${value.path}`,
      },
    );
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.value, 'handled /tmp/a.txt');
    assert.deepEqual(
      lines.map((line) => line.message),
      ['Working…', 'Saved.'],
    );
  });

  test('a native error is reported with the host message and no handle call', async () => {
    const { lines, report } = collect();
    let handled = false;
    const outcome = await withFileTransfer(
      () =>
        Promise.resolve({
          error: { code: 'READ_FAILED', message: 'Disk on fire.' },
        }),
      {
        report,
        messages: { error: 'fallback' },
        handle: () => {
          handled = true;
        },
      },
    );
    assert.equal(outcome.status, 'error');
    assert.equal(handled, false);
    assert.deepEqual(lines.at(-1), { message: 'Disk on fire.', isError: true });
  });

  test('a throw is reported, not propagated', async () => {
    const { lines, report } = collect();
    const outcome = await withFileTransfer(
      () => Promise.reject(new Error('boom')),
      {
        report,
        messages: { pending: 'Working…', error: 'fallback' },
      },
    );
    assert.equal(outcome.status, 'error');
    assert.deepEqual(lines.at(-1), { message: 'boom', isError: true });
  });

  test('a cancel is not an error and reports the caller wording', async () => {
    const { lines, report } = collect();
    const outcome = await withFileTransfer(
      () => Promise.resolve({ canceled: true }),
      {
        report,
        messages: { canceled: 'Export was cancelled.' },
      },
    );
    assert.equal(outcome.status, 'canceled');
    assert.deepEqual(lines.at(-1), {
      message: 'Export was cancelled.',
      isError: false,
    });
  });

  test('a null result (no host, no fallback) is a failure', async () => {
    const { lines, report } = collect();
    const outcome = await withFileTransfer(() => Promise.resolve(null), {
      report,
      messages: { unavailable: 'Nothing handled it.' },
    });
    assert.equal(outcome.status, 'error');
    assert.deepEqual(lines.at(-1), {
      message: 'Nothing handled it.',
      isError: true,
    });
  });

  test('an async handle is awaited before the outcome is returned', async () => {
    const { report } = collect();
    const order = [];
    await withFileTransfer(() => Promise.resolve({ ok: true }), {
      report,
      handle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push('handled');
      },
    });
    order.push('after');
    assert.deepEqual(order, ['handled', 'after']);
  });

  test('the report callback is optional', async () => {
    const outcome = await withFileTransfer(
      () => Promise.resolve({ path: '/x' }),
      {
        messages: { done: 'ok' },
      },
    );
    assert.equal(outcome.status, 'done');
  });
});

describe('the read and write wrappers', () => {
  test('a read uses the host picker when it is present', async () => {
    globalThis.window = {
      openTextFile: async () => ({ name: 'a.txt', content: 'body' }),
    };
    const { lines, report } = { lines: [], report: (m) => lines.push(m) };
    const outcome = await withTextFileRead({
      pick: async () => null,
      report,
      messages: {},
    });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.value.content, 'body');
    assert.deepEqual(lines, []);
  });

  test('a read falls back to the caller input when there is no host', async () => {
    globalThis.window = {};
    let picked = false;
    const outcome = await withTextFileRead({
      pick: async () => {
        picked = true;
        return { name: 'fallback.md', text: async () => 'from the input' };
      },
      report: () => {},
      messages: {},
    });
    assert.equal(picked, true);
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.value.name, 'fallback.md');
  });

  test('a read that falls back to nothing is a cancel, not a failure', async () => {
    globalThis.window = {};
    const { lines, report } = {
      lines: [],
      report: (m, e) => lines.push({ m, e }),
    };
    const outcome = await withTextFileRead({
      pick: async () => null,
      report,
      messages: {},
    });
    assert.equal(outcome.status, 'canceled');
    assert.equal(lines.at(-1).e, false);
  });

  test('a write passes the suggested name and content through', async () => {
    const calls = [];
    globalThis.window = {
      saveTextFile: async (name, content) => {
        calls.push([name, content]);
        return { name, path: '/tmp/x.txt', bytes: content.length };
      },
    };
    const outcome = await withTextFileWrite('x.txt', 'body', {
      report: () => {},
      messages: {},
    });
    assert.deepEqual(calls, [['x.txt', 'body']]);
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.value.path, '/tmp/x.txt');
  });
});
