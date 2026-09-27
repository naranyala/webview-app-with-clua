/*
 * Unit tests for the app shell: how tools switch, which transition hooks run,
 * and how the boot-time interaction flag behaves.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { nextTick } from 'vue';

import {
  hasUserInteracted,
  markUserInteracted,
  onViewEnterPdf,
  onViewLeaveEditor,
  selectView,
  view,
} from '../src/app-shell.js';
import { restoredWorkspace } from '../src/boot-state.js';
import { editorInput } from '../src/editor-session.js';

after(() => {
  editorInput.value = null;
});

test('the shell starts on the restored view with no interaction yet', () => {
  assert.equal(view.value, restoredWorkspace.view);
  assert.equal(hasUserInteracted(), false);
});

test('selecting a tool switches the view and marks user interaction', () => {
  selectView('toc');
  assert.equal(view.value, 'toc');
  assert.equal(hasUserInteracted(), true);
});

test('the leave-editor hook runs only when the editor is left', () => {
  const left = [];
  view.value = 'menu';
  onViewLeaveEditor(() => left.push('hook'));

  selectView('toc');
  assert.deepEqual(left, []);

  selectView('editor');
  selectView('editor');
  assert.deepEqual(left, []);

  selectView('pdf');
  assert.deepEqual(left, ['hook']);
});

test('the enter-pdf hook runs only when the reader is opened', () => {
  const entered = [];
  view.value = 'menu';
  onViewEnterPdf(() => entered.push('hook'));

  selectView('images');
  assert.deepEqual(entered, []);

  selectView('pdf');
  assert.deepEqual(entered, ['hook']);
});

test('opening the editor focuses the textarea on the next tick', async () => {
  let focused = 0;
  editorInput.value = {
    focus() {
      focused += 1;
    },
  };
  selectView('editor');
  assert.equal(focused, 0);
  await nextTick();
  assert.equal(focused, 1);
  editorInput.value = null;
});

test('the latest registered hook wins', () => {
  const seen = [];
  view.value = 'menu';
  onViewLeaveEditor(() => seen.push('first'));
  onViewLeaveEditor(() => seen.push('second'));

  view.value = 'editor';
  selectView('pdf');
  assert.deepEqual(seen, ['second']);
});

test('markUserInteracted is idempotent', () => {
  markUserInteracted();
  markUserInteracted();
  assert.equal(hasUserInteracted(), true);
});
