/*
 * Unit tests for the header pill wording: how a raw persistence report from
 * workspace.js becomes the sentence the launcher header shows.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWorkspaceReport } from '../src/workspace-report.js';

test('no report renders nothing', () => {
  assert.equal(formatWorkspaceReport(null), null);
  assert.equal(formatWorkspaceReport(undefined), null);
});

test('a save failure reads as a save failure', () => {
  const formatted = formatWorkspaceReport({
    scope: 'save',
    code: 'WRITE_FAILED',
    message: 'The workspace file could not be written.',
    at: 123,
  });
  assert.equal(formatted.scope, 'save');
  assert.equal(formatted.code, 'WRITE_FAILED');
  assert.equal(
    formatted.text,
    'Workspace not saved: The workspace file could not be written.',
  );
});

test('a load failure reads as a restore failure', () => {
  const formatted = formatWorkspaceReport({
    scope: 'load',
    code: 'INVALID_CONTENT',
    message: 'The saved workspace file is damaged and cannot be restored.',
    at: 456,
  });
  assert.equal(formatted.scope, 'load');
  assert.equal(formatted.code, 'INVALID_CONTENT');
  assert.equal(
    formatted.text,
    'Saved workspace not restored: The saved workspace file is damaged and cannot be restored.',
  );
});

test('the message keeps the punctuation the store reported', () => {
  const formatted = formatWorkspaceReport({
    scope: 'save',
    code: 'QUOTA',
    message: 'the browser storage quota is full',
  });
  assert.equal(
    formatted.text,
    'Workspace not saved: The browser storage quota is full',
  );

  const alreadyCapital = formatWorkspaceReport({
    scope: 'load',
    code: 'READ_FAILED',
    message: 'The stored workspace could not be read.',
  });
  assert.equal(
    alreadyCapital.text,
    'Saved workspace not restored: The stored workspace could not be read.',
  );
});

test('an empty message still produces a complete sentence', () => {
  const formatted = formatWorkspaceReport({
    scope: 'save',
    code: 'WRITE_FAILED',
    message: '',
  });
  assert.equal(formatted.text, 'Workspace not saved: ');
});
