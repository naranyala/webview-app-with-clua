/*
 * App shell: the active view plus the transitions between tools.
 *
 * The shell deliberately knows nothing about the individual tools. Instead the
 * owning module registers the work that must happen around a transition
 * (syncing the draft when leaving the editor, resuming a session when entering
 * the PDF reader), which keeps this module free of imports that would form a
 * cycle with the tools it routes to.
 *
 * createAppShell() takes the editor's template ref as a dependency, so the
 * routing logic can be tested with a stub focus() instead of a real textarea.
 */
import { nextTick, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { editorInput } from './editor-session.js';

export function createAppShell({
  boot = restoredWorkspace,
  editorRef = editorInput,
  afterNextTick = nextTick,
} = {}) {
  /* Active tool: 'menu' | 'editor' | 'pdf' | 'images' | 'toc'. */
  const view = ref(boot.view);

  /*
   * Set on the first deliberate user action. Boot-time hydration never wins
   * over a state the user has already changed.
   */
  let userInteracted = false;
  let leaveEditorHook = () => {};
  let enterPdfHook = () => {};

  function markUserInteracted() {
    userInteracted = true;
  }

  function hasUserInteracted() {
    return userInteracted;
  }

  /* Called when the editor is left, before the view actually changes. */
  function onViewLeaveEditor(hook) {
    leaveEditorHook = hook;
  }

  /* Called after switching to the PDF view (used to resume a stored session). */
  function onViewEnterPdf(hook) {
    enterPdfHook = hook;
  }

  /* Switches tools, flushing the draft and resuming sessions as needed. */
  function selectView(nextView) {
    markUserInteracted();
    if (view.value === 'editor' && nextView !== 'editor') leaveEditorHook();
    view.value = nextView;
    if (nextView === 'editor') {
      afterNextTick(() => editorRef.value?.focus());
    }
    if (nextView === 'pdf') enterPdfHook();
  }

  return {
    view,
    selectView,
    markUserInteracted,
    hasUserInteracted,
    onViewLeaveEditor,
    onViewEnterPdf,
  };
}

const shell = createAppShell();

export const view = shell.view;
export const selectView = shell.selectView;
export const markUserInteracted = shell.markUserInteracted;
export const hasUserInteracted = shell.hasUserInteracted;
export const onViewLeaveEditor = shell.onViewLeaveEditor;
export const onViewEnterPdf = shell.onViewEnterPdf;
