/*
 * The binding surface, checked from three sides at once.
 *
 * `src/webview_app.c` registers what the host offers, `docs/bridge-protocol.md`
 * is what a reader trusts describes it, and the frontend is what actually calls.
 * Those three drifted apart without anything noticing: a binding added to the host
 * is invisible until the docs are updated, and a doc that omits one sends a
 * reader looking for a call that does not exist.
 *
 * Read as text rather than by importing, because `webview_app.c` pulls in GTK and
 * the WebView library and cannot be loaded here. That is also the right level for
 * the question being asked: the question is whether three *lists* agree, not
 * whether the code works.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);

const host = readFileSync(new URL('src/webview_app.c', ROOT), 'utf8');
const protocol = readFileSync(new URL('docs/bridge-protocol.md', ROOT), 'utf8');

/* `webview_bind(app.view, "name", ...)` is the only way a binding is offered. */
const hostBindings = [
  ...host.matchAll(/webview_bind\(\s*app\.view,\s*"([A-Za-z]+)"/g),
].map((match) => match[1]);

test('the host registers the bindings it claims to', () => {
  assert.deepEqual(
    hostBindings,
    [
      'summarize',
      'openPdf',
      'openPdfAt',
      'openImageDirectory',
      'openImageDirectoryAt',
      'loadImageAt',
      'chooseOutlineDirectory',
      'renderOutlinePdf',
      'extractPdfToc',
      'loadWorkspace',
      'saveWorkspace',
      'openTextFile',
      'saveTextFile',
      'smokeVerdict',
    ],
    'the registered set changed; docs/bridge-protocol.md and the frontend need to know',
  );
});

test('every binding the host registers is named in the protocol document', () => {
  /*
   * A word-boundary match, not a backticked one. An earlier version of this test
   * required the name in backticks and reported openImageDirectoryAt,
   * extractPdfToc, and smokeVerdict as undocumented - all three are described in
   * the document, two of them inside fenced code blocks where backticks would be
   * wrong. The question being asked is "is this documented", and the formatter
   * used for the answer should not be a stricter one than the question.
   */
  const undocumented = hostBindings.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(protocol),
  );
  assert.deepEqual(
    undocumented,
    [],
    `registered but not documented in docs/bridge-protocol.md: ${undocumented.join(', ')}`,
  );
});

test('the protocol document names no binding the host does not register', () => {
  /*
   * The other direction, and the one that catches a doc describing a feature that
   * was planned and never built. Scoped to the `window.<name>(` shape the document
   * uses when it shows a call, so ordinary prose mentioning a binding's name in a
   * heading does not count as a claim.
   */
  const claimed = [...protocol.matchAll(/window\.([a-zA-Z]+)\(/g)].map(
    (match) => match[1],
  );
  const unclaimed = [...new Set(claimed)].filter(
    (name) => !hostBindings.includes(name),
  );
  assert.deepEqual(
    unclaimed,
    [],
    `docs/bridge-protocol.md shows calls to bindings the host does not register: ${unclaimed.join(', ')}`,
  );
});

test('the smoke verdict binding is the only conditional one, and says so', () => {
  /* It exists only under METRICS_SMOKE. A second conditional binding would need
     the same note, or a browser preview would wait forever on one that is never
     going to arrive. */
  /* The guard is a `smoke_enabled() &&` clause on the binding itself, not a
     branch elsewhere in the file - a browser preview must find the binding simply
     absent rather than present and failing. */
  assert.match(
    host,
    /if \(smoke_enabled\(\) &&[\s\S]{0,160}webview_bind\(app\.view, "smokeVerdict"/,
    'smokeVerdict must be registered behind its own guard, in that order',
  );
  assert.match(
    protocol,
    /binding is absent\s+without\s+`METRICS_SMOKE`/,
    'the conditional binding must be documented as conditional',
  );
});
