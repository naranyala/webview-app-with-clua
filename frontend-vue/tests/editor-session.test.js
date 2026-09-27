/*
 * Unit tests for the Text Editor session: the reactive word counter and the
 * caret readout derived from the textarea selection.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  cursorPosition,
  editorContent,
  editorInput,
  editorWordCount,
  updateCursor,
} from '../src/editor-session.js';

after(() => {
  editorInput.value = null;
});

test('the word counter tracks the draft buffer', () => {
  editorContent.value = '';
  assert.equal(editorWordCount.value, 0);

  editorContent.value = '   \n\t ';
  assert.equal(editorWordCount.value, 0);

  editorContent.value = 'one';
  assert.equal(editorWordCount.value, 1);

  editorContent.value = 'one two\nthree';
  assert.equal(editorWordCount.value, 3);
});

test('the caret readout is unchanged without a textarea', () => {
  cursorPosition.value = 'Line 9, Col 9';
  editorInput.value = null;
  updateCursor();
  assert.equal(cursorPosition.value, 'Line 9, Col 9');
});

test('the caret readout follows the selection', () => {
  editorInput.value = {
    value: 'hello',
    selectionStart: 5,
  };
  updateCursor();
  assert.equal(cursorPosition.value, 'Line 1, Col 6');

  editorInput.value.value = 'a\nbc';
  editorInput.value.selectionStart = 4;
  updateCursor();
  assert.equal(cursorPosition.value, 'Line 2, Col 3');

  editorInput.value.selectionStart = 0;
  updateCursor();
  assert.equal(cursorPosition.value, 'Line 1, Col 1');
});

test('a missing selectionStart is treated as the start of the text', () => {
  editorInput.value = { value: 'abc' };
  updateCursor();
  assert.equal(cursorPosition.value, 'Line 1, Col 1');
  editorInput.value = null;
});
