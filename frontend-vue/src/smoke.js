/*
 * Desktop smoke checks: the frontend half of the GUI smoke test.
 *
 * When the host injects window.__METRICS_SMOKE__ (METRICS_SMOKE=1, see
 * src/smoke.c) the bundle runs the checks below against the real DOM and the
 * real bindings, then hands one verdict to the smokeVerdict binding, which
 * turns it into the process exit code. Nothing here runs in a normal launch,
 * and the checks are pure functions over injected dependencies so
 * tests/smoke.test.js can cover them without a GUI.
 */

import { getNativeBinding, runNativeCall } from './native-bridge.js';

/* True when the host started this page as a smoke run. */
export function smokeRequested(scope = globalThis) {
  return scope.__METRICS_SMOKE__ === 1;
}

/* True when the run is isolated (XDG_DATA_HOME set) and may write the store. */
export function smokeMayPersist(scope = globalThis) {
  return scope.__METRICS_SMOKE_WRITABLE__ === 1;
}

/*
 * Elements the real UI must have rendered before any check is worth running.
 * They are structural, never state-dependent: the five tool panes use v-show,
 * and the editor gate (.toc-pick) is what a fresh boot always shows.
 */
const REQUIRED_ANCHORS = [
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

/* One card per tool on the launcher, so the count and the pane count agree. */
const EXPECTED_MENU_CARDS = 5;

/* Values exercising a normal summarize call: count 4, sum 10, mean 2.5. */
const REPRESENTATIVE_VALUES = [1, 2, 3, 4];

const WORKSPACE_PROBE = { smoke: true, checkedAt: 'smoke' };

function check(name, ok, detail) {
  return { name, ok, detail };
}

/* Confirms Vue rendered the real shell rather than an error page. */
export function checkDom(doc) {
  if (!doc || typeof doc.querySelector !== 'function') {
    return check('dom-anchors', false, 'no document to inspect');
  }
  const missing = REQUIRED_ANCHORS.filter(
    (selector) => doc.querySelector(selector) === null,
  );
  const cards = doc.querySelectorAll
    ? doc.querySelectorAll('.app-card').length
    : 0;
  if (missing.length > 0) {
    return check('dom-anchors', false, `missing ${missing.join(' ')}`);
  }
  if (cards !== EXPECTED_MENU_CARDS) {
    return check(
      'dom-anchors',
      false,
      `expected ${EXPECTED_MENU_CARDS} menu cards, found ${cards}`,
    );
  }
  return check(
    'dom-anchors',
    true,
    `${REQUIRED_ANCHORS.length} anchors, ${EXPECTED_MENU_CARDS} menu cards`,
  );
}

/* A representative summarize call must come back as a summary object. */
export function checkSummarize(response) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.error !== undefined
  ) {
    return check(
      'summarize-values',
      false,
      `unexpected response ${JSON.stringify(response)}`,
    );
  }
  const { count, sum, mean } = response;
  if (count !== REPRESENTATIVE_VALUES.length || sum !== 10 || mean !== 2.5) {
    return check(
      'summarize-values',
      false,
      `count=${count} sum=${sum} mean=${mean}`,
    );
  }
  return check(
    'summarize-values',
    true,
    `count=${count} sum=${sum} mean=${mean}`,
  );
}

/* Bad input must come back as the shared error shape, not a summary. */
export function checkSummarizeRejects(response) {
  const code =
    response === null || typeof response !== 'object'
      ? undefined
      : response.error?.code;
  if (
    response === null ||
    typeof response !== 'object' ||
    response.count !== undefined
  ) {
    return check(
      'summarize-rejects',
      false,
      `bad input was accepted: ${JSON.stringify(response)}`,
    );
  }
  if (typeof code !== 'string' || code === '') {
    return check('summarize-rejects', false, 'error response carried no code');
  }
  return check('summarize-rejects', true, `code=${code}`);
}

/* The workspace binding must answer the ok/workspace shape. */
export function checkLoadWorkspace(response) {
  if (
    response === null ||
    typeof response !== 'object' ||
    response.ok !== true
  ) {
    return check(
      'workspace-read',
      false,
      `unexpected response ${JSON.stringify(response)}`,
    );
  }
  const workspace = response.workspace;
  if (
    workspace !== null &&
    (typeof workspace !== 'object' || Array.isArray(workspace))
  ) {
    return check(
      'workspace-read',
      false,
      'workspace is neither null nor an object',
    );
  }
  return check(
    'workspace-read',
    true,
    workspace === null ? 'no stored workspace' : 'stored workspace restored',
  );
}

/* Only run when the store is isolated: a real workspace must not be rewritten. */
export function checkWorkspaceRoundTrip(saveResponse, loadResponse) {
  if (
    saveResponse === null ||
    typeof saveResponse !== 'object' ||
    saveResponse.ok !== true
  ) {
    return check(
      'workspace-round-trip',
      false,
      `save failed: ${JSON.stringify(saveResponse)}`,
    );
  }
  const workspace =
    loadResponse === null || typeof loadResponse !== 'object'
      ? undefined
      : loadResponse.workspace;
  if (
    workspace === null ||
    typeof workspace !== 'object' ||
    workspace.smoke !== true
  ) {
    return check(
      'workspace-round-trip',
      false,
      `saved probe was not read back: ${JSON.stringify(loadResponse)}`,
    );
  }
  return check('workspace-round-trip', true, 'probe survived save and load');
}

/* One-line report: the host greps this, so newlines would break the contract. */
export function buildReport(results) {
  const passed = results.filter((result) => result.ok).length;
  const failures = results
    .filter((result) => !result.ok)
    .map((result) => `${result.name} (${result.detail})`)
    .join('; ');
  return `checks=${passed}/${results.length}${failures === '' ? '' : ` failed: ${failures}`}`.replaceAll(
    /[\r\n\t]+/g,
    ' ',
  );
}

/*
 * Runs every check, then reports the verdict through the host binding. The
 * binding lookup and the call wrapper are both injectable so the sequence can
 * be tested without a window; the verdict is a string flag rather than a
 * boolean because the host decodes it strictly, and a missing binding still
 * yields a verdict object for the caller.
 */
export async function runDesktopSmoke({
  doc = globalThis.document,
  run = runNativeCall,
  resolve = getNativeBinding,
  binding = resolve('smokeVerdict'),
  mayPersist = smokeMayPersist(),
} = {}) {
  const results = [checkDom(doc)];

  /*
   * A bridge that throws is a failed check, never a thrown smoke run: the
   * window would stay open until the runner's timeout killed it, and the
   * report of what broke would be lost.
   */
  const attempt = async (invoke) => {
    try {
      return await run(invoke);
    } catch (error) {
      return { error: { message: String(error) } };
    }
  };

  results.push(
    checkSummarize(
      await attempt(() => resolve('summarize')([...REPRESENTATIVE_VALUES])),
    ),
  );
  results.push(
    checkSummarizeRejects(
      await attempt(() => resolve('summarize')(['not-a-number'])),
    ),
  );

  const load = await attempt(() => resolve('loadWorkspace')());
  results.push(checkLoadWorkspace(load));

  if (mayPersist) {
    const saved = await attempt(() =>
      resolve('saveWorkspace')(JSON.stringify(WORKSPACE_PROBE)),
    );
    const reloaded = await attempt(() => resolve('loadWorkspace')());
    results.push(checkWorkspaceRoundTrip(saved, reloaded));
  }

  const verdict = { pass: results.every((result) => result.ok), results };
  verdict.report = buildReport(results);

  if (typeof binding === 'function') {
    try {
      await binding(verdict.pass ? '1' : '0', verdict.report);
      verdict.reported = true;
    } catch (error) {
      verdict.reported = false;
      verdict.reportError = String(error);
    }
  } else {
    verdict.reported = false;
  }

  return verdict;
}
