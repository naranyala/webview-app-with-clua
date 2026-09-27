/*
 * Text Editor session: the draft buffer, the caret readout, and the word
 * counter badge.
 *
 * The buffer is owned here and bound to the outline by toc-outline.js, which
 * copies it into the active item whenever the user leaves the editor.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { countWords } from './workspace.js';

/* Draft text for the active outline item (or a free-standing document). */
export const editorContent = ref(restoredWorkspace.editor.content);
/* Live caret position shown in the footer, "Line 1, Col 1" style. */
export const cursorPosition = ref('Line 1, Col 1');
/* Template ref for the <textarea>, used for focus and selection reads. */
export const editorInput = ref(null);

export const editorWordCount = computed(() => countWords(editorContent.value));

/* Recomputes the footer caret position from the current selection. */
export function updateCursor() {
  const input = editorInput.value;
  if (!input) return;
  const lines = input.value.slice(0, input.selectionStart ?? 0).split('\n');
  cursorPosition.value = `Line ${lines.length}, Col ${(lines.at(-1)?.length ?? 0) + 1}`;
}
