/*
 * Combined-outline PDF session: the one workspace directory, the "combine"
 * action, and the generated file's identity.
 *
 * The host owns the directory. The webview never names a path to write into:
 * `chooseOutlineDirectory` opens the folder chooser and the host remembers what
 * the user picked, and `renderOutlinePdf` will only write inside that. The
 * frontend stores the path so the toolbar can show it, and so a user who already
 * chose one sees it after a restart, but the stored value is display only - the
 * host re-asks after a fresh process.
 *
 * The result is an ordinary file, so the preview is the existing PDF reader:
 * `openPdfAt` on the returned path. No new viewer, no in-memory handoff.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { withFileTransfer } from './file-io.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';

export function createOutlinePdfSession({
  boot = restoredWorkspace,
  native = getNativeBinding,
  call = runNativeCall,
} = {}) {
  /* Display-only copy of the path the user last chose. */
  const workspaceDirectory = ref(boot.pdf.workspaceDirectory);
  const outlinePdfStatus = ref(
    boot.pdf.workspaceDirectory
      ? `Combined PDFs are written to ${boot.pdf.workspaceDirectory}.`
      : 'Choose a workspace folder to hold the combined outline.',
  );
  const outlinePdfStatusError = ref(false);
  const outlinePdfBusy = ref(false);
  const lastOutlinePdf = ref(null);

  function setOutlinePdfStatus(message, isError = false) {
    outlinePdfStatus.value = message;
    outlinePdfStatusError.value = isError;
  }

  /*
   * Asks the host for the one workspace directory. Outside the desktop host
   * there is nothing to write through, so this explains itself rather than
   * pretending the folder was chosen.
   */
  async function chooseWorkspaceDirectory() {
    const choose = native('chooseOutlineDirectory');
    if (!choose) {
      setOutlinePdfStatus(
        'Choosing a workspace folder is available in the desktop app.',
        true,
      );
      return null;
    }
    const outcome = await withFileTransfer(() => call(choose), {
      report: setOutlinePdfStatus,
      messages: {
        pending: 'Waiting for the system folder picker…',
        canceled: 'Folder selection was cancelled.',
        error: 'Could not choose a workspace folder.',
      },
    });
    if (outcome.status !== 'done') return null;
    const path = String(outcome.result?.path || '');
    if (!path) {
      setOutlinePdfStatus('The chosen folder did not provide a path.', true);
      return null;
    }
    workspaceDirectory.value = path;
    setOutlinePdfStatus(`Combined PDFs are written to ${path}.`);
    return path;
  }

  /*
   * Renders `outlineJson` to <workspace folder>/<suggested name> and returns the
   * host's answer, or null on cancel or failure. The name is sanitized again on
   * the host side; this only keeps a helpful default.
   */
  async function renderOutlinePdf(outlineJson, suggestedName = 'outline') {
    const render = native('renderOutlinePdf');
    if (!render) {
      setOutlinePdfStatus(
        'Combining the outline is available in the desktop app.',
        true,
      );
      return null;
    }
    if (String(outlineJson ?? '').trim() === '') {
      setOutlinePdfStatus('There is nothing to combine yet.', true);
      return null;
    }
    outlinePdfBusy.value = true;
    const outcome = await withFileTransfer(
      () => call(() => render(String(suggestedName), String(outlineJson))),
      {
        report: setOutlinePdfStatus,
        messages: {
          pending: 'Combining the outline into a PDF…',
          error: 'The combined PDF could not be written.',
        },
      },
    );
    outlinePdfBusy.value = false;
    if (outcome.status !== 'done') return null;
    const result = outcome.result ?? {};
    const path = String(result.path || '');
    if (!path) {
      setOutlinePdfStatus(
        'The combined PDF did not report where it was written.',
        true,
      );
      return null;
    }
    lastOutlinePdf.value = {
      path,
      name: String(result.name || ''),
      pages: Number(result.pages) || 0,
      bytes: Number(result.bytes) || 0,
    };
    setOutlinePdfStatus(
      `Wrote ${lastOutlinePdf.value.name} · ${lastOutlinePdf.value.pages} page${
        lastOutlinePdf.value.pages === 1 ? '' : 's'
      }.`,
    );
    return lastOutlinePdf.value;
  }

  /* Human-readable file size for the status line. */
  const outlinePdfSummary = computed(() => {
    const last = lastOutlinePdf.value;
    if (!last) return '';
    const kilobytes = Math.max(1, Math.round(last.bytes / 1024));
    return `${last.name} · ${last.pages} page${
      last.pages === 1 ? '' : 's'
    } · ${kilobytes} kB`;
  });

  return {
    workspaceDirectory,
    outlinePdfStatus,
    outlinePdfStatusError,
    outlinePdfBusy,
    lastOutlinePdf,
    outlinePdfSummary,
    setOutlinePdfStatus,
    chooseWorkspaceDirectory,
    renderOutlinePdf,
  };
}

const session = createOutlinePdfSession();

export const workspaceDirectory = session.workspaceDirectory;
export const outlinePdfStatus = session.outlinePdfStatus;
export const outlinePdfStatusError = session.outlinePdfStatusError;
export const outlinePdfBusy = session.outlinePdfBusy;
export const lastOutlinePdf = session.lastOutlinePdf;
export const outlinePdfSummary = session.outlinePdfSummary;
export const setOutlinePdfStatus = session.setOutlinePdfStatus;
export const chooseWorkspaceDirectory = session.chooseWorkspaceDirectory;
export const renderOutlinePdf = session.renderOutlinePdf;
