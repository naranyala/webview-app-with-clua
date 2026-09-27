/*
 * Tests for the smoke runner. The checks run against a stub document and stub
 * bindings, so the whole sequence (including verdict reporting) is covered
 * without a GUI; the real DOM and real bridge are exercised by
 * scripts/smoke.sh.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  buildReport,
  checkDom,
  checkLoadWorkspace,
  checkSummarize,
  checkSummarizeRejects,
  checkWorkspaceRoundTrip,
  runDesktopSmoke,
  smokeMayPersist,
  smokeRequested,
} from '../src/smoke.js';

const SMOKE_ANCHORS = [
  '.app-shell',
  '.app-grid',
  '.toc-manager-toolbar',
  '#toc-manager-status',
  '.toc-pick',
  '.editor-app',
  '.pdf-app',
  '.image-app',
  '.map-app',
];

function fakeDocument({ missing = [], cards = 5 } = {}) {
  const present = new Set(SMOKE_ANCHORS);
  for (const selector of missing) present.delete(selector);
  return {
    querySelector: (selector) => (present.has(selector) ? { selector } : null),
    querySelectorAll: (selector) =>
      selector === '.app-card' ? Array.from({ length: cards }, () => ({})) : [],
  };
}

/* Answers each binding from a table, recording the arguments it was called with. */
function fakeHost(responses) {
  const calls = [];
  const bindings = {};
  for (const name of ['summarize', 'loadWorkspace', 'saveWorkspace']) {
    bindings[name] = (...args) => {
      calls.push({ name, args });
      const handler = responses[name];
      return typeof handler === 'function' ? handler(...args) : handler;
    };
  }
  return { calls, bindings };
}

const globalRef = globalThis;
let savedDescriptor;

afterEach(() => {
  if (savedDescriptor) {
    Object.defineProperty(globalRef, '__METRICS_SMOKE__', savedDescriptor);
    savedDescriptor = undefined;
  }
  delete globalRef.__METRICS_SMOKE_WRITABLE__;
});

function setMarker(value, writable) {
  if (value === undefined) {
    delete globalRef.__METRICS_SMOKE__;
  } else {
    savedDescriptor = Object.getOwnPropertyDescriptor(
      globalRef,
      '__METRICS_SMOKE__',
    );
    globalRef.__METRICS_SMOKE__ = value;
  }
  if (writable === undefined) {
    delete globalRef.__METRICS_SMOKE_WRITABLE__;
  } else {
    globalRef.__METRICS_SMOKE_WRITABLE__ = writable;
  }
}

describe('smoke mode detection', () => {
  test('only the numeric marker from the host counts', () => {
    setMarker(1, 1);
    assert.equal(smokeRequested(), true);
    assert.equal(smokeMayPersist(), true);
  });

  test('a normal launch and a string marker are both off', () => {
    setMarker(undefined);
    assert.equal(smokeRequested(), false);
    assert.equal(smokeMayPersist(), false);
    setMarker('1');
    assert.equal(smokeRequested(), false);
  });
});

describe('DOM check', () => {
  test('the real shell anchors are required', () => {
    assert.deepEqual(checkDom(fakeDocument()), {
      name: 'dom-anchors',
      ok: true,
      detail: '9 anchors, 5 menu cards',
    });
  });

  test('a missing anchor or a wrong card count fails', () => {
    assert.equal(
      checkDom(fakeDocument({ missing: ['.editor-app'] })).ok,
      false,
    );
    assert.equal(checkDom(fakeDocument({ cards: 4 })).ok, false);
  });

  test('no document at all fails instead of throwing', () => {
    assert.equal(checkDom(null).ok, false);
    assert.equal(checkDom({}).ok, false);
  });
});

describe('bridge response checks', () => {
  test('a representative summary passes', () => {
    assert.deepEqual(
      checkSummarize({
        count: 4,
        sum: 10,
        min: 1,
        max: 4,
        mean: 2.5,
        variance: 1.25,
      }),
      {
        name: 'summarize-values',
        ok: true,
        detail: 'count=4 sum=10 mean=2.5',
      },
    );
  });

  test('a wrong or missing summary fails', () => {
    assert.equal(checkSummarize({ count: 3, sum: 6, mean: 2 }).ok, false);
    assert.equal(
      checkSummarize({ error: { code: 'X', message: 'y' } }).ok,
      false,
    );
    assert.equal(checkSummarize(null).ok, false);
  });

  test('rejected input must carry an error code', () => {
    assert.deepEqual(
      checkSummarizeRejects({
        error: { code: 'INVALID_VALUE', message: 'bad' },
      }),
      {
        name: 'summarize-rejects',
        ok: true,
        detail: 'code=INVALID_VALUE',
      },
    );
    assert.equal(checkSummarizeRejects({ count: 4 }).ok, false);
    assert.equal(
      checkSummarizeRejects({ error: { message: 'no code' } }).ok,
      false,
    );
  });

  test('the workspace read accepts both first run and restored state', () => {
    assert.equal(checkLoadWorkspace({ ok: true, workspace: null }).ok, true);
    assert.equal(
      checkLoadWorkspace({ ok: true, workspace: { items: [] } }).ok,
      true,
    );
    assert.equal(checkLoadWorkspace({ ok: true, workspace: 'nope' }).ok, false);
    assert.equal(
      checkLoadWorkspace({ error: { code: 'READ_FAILED', message: 'x' } }).ok,
      false,
    );
  });

  test('the round trip needs both halves', () => {
    assert.equal(
      checkWorkspaceRoundTrip(
        { ok: true },
        { ok: true, workspace: { smoke: true } },
      ).ok,
      true,
    );
    assert.equal(
      checkWorkspaceRoundTrip(
        { error: { code: 'WRITE_FAILED' } },
        { ok: true, workspace: null },
      ).ok,
      false,
    );
    assert.equal(
      checkWorkspaceRoundTrip(
        { ok: true },
        { ok: true, workspace: { smoke: false } },
      ).ok,
      false,
    );
  });
});

describe('report building', () => {
  test('a clean run reports the count and no failures', () => {
    assert.equal(
      buildReport([
        { name: 'a', ok: true, detail: 'x' },
        { name: 'b', ok: true, detail: 'y' },
      ]),
      'checks=2/2',
    );
  });

  test('failures are named and the line stays single', () => {
    const report = buildReport([
      { name: 'a', ok: true, detail: 'x' },
      { name: 'b', ok: false, detail: 'line one\nline two' },
    ]);
    assert.equal(report, 'checks=1/2 failed: b (line one line two)');
    assert.ok(!report.includes('\n'));
  });
});

describe('the smoke sequence', () => {
  const summary = {
    count: 4,
    sum: 10,
    min: 1,
    max: 4,
    mean: 2.5,
    variance: 1.25,
  };

  /* The pass/fail half of summarize: numbers summarize, anything else errors. */
  const summarize = (values) =>
    typeof values[0] === 'number'
      ? summary
      : { error: { code: 'INVALID_VALUE', message: 'bad' } };

  test('passes, sends the verdict, and stays read-only by default', async () => {
    const host = fakeHost({
      summarize,
      loadWorkspace: { ok: true, workspace: null },
    });
    const verdicts = [];
    const verdict = await runDesktopSmoke({
      doc: fakeDocument(),
      run: (call) => call(),
      resolve: (name) => host.bindings[name],
      binding: async (...args) => {
        verdicts.push(args);
      },
      mayPersist: false,
    });

    assert.equal(verdict.pass, true);
    assert.equal(verdict.report, 'checks=4/4');
    assert.equal(verdict.reported, true);
    assert.deepEqual(verdicts, [['1', 'checks=4/4']]);
    assert.equal(
      host.calls.some((call) => call.name === 'saveWorkspace'),
      false,
    );
    assert.deepEqual(host.calls[0].args, [[1, 2, 3, 4]]);
  });

  test('persists and reads back the probe when the run is isolated', async () => {
    let stored = null;
    const host = fakeHost({
      summarize,
      loadWorkspace: () => ({ ok: true, workspace: stored }),
      saveWorkspace: (payload) => {
        stored = JSON.parse(payload);
        return { ok: true };
      },
    });
    const verdict = await runDesktopSmoke({
      doc: fakeDocument(),
      run: (call) => call(),
      resolve: (name) => host.bindings[name],
      binding: async () => {},
      mayPersist: true,
    });

    assert.equal(verdict.pass, true);
    assert.equal(verdict.report, 'checks=5/5');
    const save = host.calls.find((call) => call.name === 'saveWorkspace');
    assert.deepEqual(JSON.parse(save.args[0]), {
      smoke: true,
      checkedAt: 'smoke',
    });
  });

  test('a failing check flips the verdict to fail and names itself', async () => {
    const host = fakeHost({
      summarize,
      loadWorkspace: { ok: true, workspace: null },
    });
    const verdicts = [];
    const verdict = await runDesktopSmoke({
      doc: fakeDocument({ missing: ['.editor-app'] }),
      run: (call) => call(),
      resolve: (name) => host.bindings[name],
      binding: async (...args) => {
        verdicts.push(args);
      },
      mayPersist: false,
    });

    assert.equal(verdict.pass, false);
    assert.equal(verdict.reported, true);
    assert.match(
      verdict.report,
      /checks=3\/4 failed: dom-anchors \(missing \.editor-app\)/,
    );
    assert.deepEqual(verdicts, [['0', verdict.report]]);
  });

  test('a missing host never throws: every check simply fails', async () => {
    const verdict = await runDesktopSmoke({
      doc: fakeDocument(),
      run: (call) => call(),
      resolve: () => null,
      binding: null,
      mayPersist: false,
    });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.reported, false);
    assert.match(verdict.report, /summarize-values/);
  });

  test('a rejected verdict is recorded instead of thrown', async () => {
    const host = fakeHost({
      summarize,
      loadWorkspace: { ok: true, workspace: null },
    });
    const verdict = await runDesktopSmoke({
      doc: fakeDocument(),
      run: (call) => call(),
      resolve: (name) => host.bindings[name],
      binding: async () => {
        throw new Error('host rejected the verdict');
      },
      mayPersist: false,
    });
    assert.equal(verdict.pass, true);
    assert.equal(verdict.reported, false);
    assert.match(verdict.reportError, /host rejected the verdict/);
  });
});
