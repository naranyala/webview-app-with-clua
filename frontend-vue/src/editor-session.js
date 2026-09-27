/*
 * Text Editor session: the draft buffer, the caret readout, the word counter
 * badge, and the transfer notice.
 *
 * createEditorSession() is the real module: a factory whose only dependency is
 * the boot snapshot, so a test can hold two independent editors. The exported
 * refs below are the app's single default instance, which is what App.vue and
 * the other session modules import.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { countWords } from './workspace.js';

export function createEditorSession({ boot = restoredWorkspace } = {}) {
  /* Draft text for the active outline item (or a free-standing document). */
  const editorContent = ref(boot.editor.content);
  /* Live caret position shown in the footer, "Line 1, Col 1" style. */
  const cursorPosition = ref('Line 1, Col 1');
  /* Template ref for the <textarea>, used for focus and selection reads. */
  const editorInput = ref(null);
  /* Transfer feedback for import/export actions, shown in the footer. */
  const editorNotice = ref('');
  const editorNoticeError = ref(false);

  const editorWordCount = computed(() => countWords(editorContent.value));

  /* Sets (or clears, with an empty message) the import/export footer notice. */
  function setEditorNotice(message, isError = false) {
    editorNotice.value = message;
    editorNoticeError.value = isError;
  }

  function clearEditorNotice() {
    setEditorNotice('');
  }

  /* Recomputes the footer caret position from the current selection. */
  function updateCursor() {
    const input = editorInput.value;
    if (!input) return;
    const lines = input.value.slice(0, input.selectionStart ?? 0).split('\n');
    cursorPosition.value = `Line ${lines.length}, Col ${(lines.at(-1)?.length ?? 0) + 1}`;
  }

  return {
    editorContent,
    cursorPosition,
    editorInput,
    editorNotice,
    editorNoticeError,
    editorWordCount,
    setEditorNotice,
    clearEditorNotice,
    updateCursor,
  };
}

const session = createEditorSession();

export const editorContent = session.editorContent;
export const cursorPosition = session.cursorPosition;
export const editorInput = session.editorInput;
export const editorNotice = session.editorNotice;
export const editorNoticeError = session.editorNoticeError;
export const editorWordCount = session.editorWordCount;
export const setEditorNotice = session.setEditorNotice;
export const clearEditorNotice = session.clearEditorNotice;
export const updateCursor = session.updateCursor;
