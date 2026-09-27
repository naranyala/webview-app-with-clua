/*
 * App shell: the active view plus the transitions between tools.
 *
 * The shell deliberately knows nothing about the individual tools. Instead the
 * owning module registers the work that must happen around a transition
 * (syncing the draft when leaving the editor, resuming a session when entering
 * the PDF reader), which keeps this module free of imports that would form a
 * cycle with the tools it routes to.
 */
import { nextTick, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { editorInput } from './editor-session.js';

/* Active tool: 'menu' | 'editor' | 'pdf' | 'images' | 'toc'. */
export const view = ref(restoredWorkspace.view);

/*
 * Set on the first deliberate user action. Boot-time hydration never wins over
 * a state the user has already changed.
 */
let userInteracted = false;
let leaveEditorHook = () => {};
let enterPdfHook = () => {};

export function markUserInteracted() {
  userInteracted = true;
}

export function hasUserInteracted() {
  return userInteracted;
}

/* Called when the editor is left, before the view actually changes. */
export function onViewLeaveEditor(hook) {
  leaveEditorHook = hook;
}

/* Called after switching to the PDF view (used to resume a stored session). */
export function onViewEnterPdf(hook) {
  enterPdfHook = hook;
}

/* Switches tools, flushing the draft and resuming sessions as needed. */
export function selectView(nextView) {
  markUserInteracted();
  if (view.value === 'editor' && nextView !== 'editor') leaveEditorHook();
  view.value = nextView;
  if (nextView === 'editor') {
    nextTick(() => editorInput.value?.focus());
  }
  if (nextView === 'pdf') enterPdfHook();
}
