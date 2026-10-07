/*
 * Moving the outline and the active draft across a file boundary, plus
 * normalization.
 *
 * Every one of these has two paths - the desktop host's picker and the browser's
 * hidden input - and both are exercised. That is the reason the file is its own
 * size: the cases are long because each one has to assert what the reader is told
 * on cancel, on refusal, and on success, not only that the bytes moved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { view } from '../src/app-shell.js';
import {
  editorContent,
  editorNotice,
  editorNoticeError,
} from '../src/editor-session.js';
import { imageStatus } from '../src/image-session.js';
import {
  activeTocId,
  activeTocItem,
  addTocItem,
  attachImageToToc,
  editorImportInput,
  exportActiveDraftToFile,
  exportTocJson,
  exportTocToFile,
  handleEditorImportFile,
  handleTocImportFile,
  importActiveDraftFromFile,
  importTocFromFile,
  importTocJson,
  lastRemoved,
  selectTocItem,
  tocDraftTitle,
  tocImportInput,
  tocItems,
  tocStatus,
  tocStatusError,
} from '../src/toc-outline.js';
import {
  MAX_IMAGES_PER_ITEM,
  normalizeWorkspace,
  serializeWorkspace,
} from '../src/workspace.js';
import {
  makeItem,
  persistCount,
  resetOutline,
} from './support/toc-fixtures.mjs';

/*
 * A well-formed outline document, so each case states the thing it is actually
 * testing rather than repeating the envelope. The envelope itself is pinned by
 * "exportTocJson emits a versioned envelope" in toc-outline-transfer.test.js and by
 * the normalization case at the end of this file.
 */
const validOutlineJson = (items) =>
  JSON.stringify({ format: 'metrics-toc', version: 1, items });

/*
 * Lets the file transfer's internal promise chain settle.
 *
 * Every path here is async - the host binding, the Blob, the input event - and an
 * assertion made one microtask early reads the state before the thing it is
 * checking has happened.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('exportTocJson emits a versioned envelope without ids', () => {
  resetOutline([
    makeItem({ title: 'Alpha', level: 2, content: 'body' }),
    makeItem({ title: 'Beta' }),
  ]);
  const payload = JSON.parse(exportTocJson());
  assert.equal(payload.format, 'metrics-toc');
  assert.equal(payload.version, 1);
  assert.ok(payload.exportedAt);
  assert.equal(payload.items.length, 2);
  assert.equal(payload.items[0].title, 'Alpha');
  assert.equal(payload.items[0].level, 2);
  assert.equal(payload.items[0].content, 'body');
  assert.ok(!('id' in payload.items[0]));
  assert.ok('links' in payload.items[0]);
});
test('importTocJson appends sections with fresh ids and persists', () => {
  const existing = makeItem({ title: 'Existing' });
  resetOutline([existing], existing.id);
  lastRemoved.value = { item: existing, index: 0, wasActive: true };
  const before = persistCount();
  const ok = importTocJson(
    validOutlineJson([
      { title: 'Imported', level: 3, content: 'new body' },
      { title: 'Second', level: 1 },
    ]),
    'outline.json',
  );
  assert.equal(ok, true);
  assert.ok(persistCount() > before);
  assert.equal(tocItems.value.length, 3);
  assert.notEqual(tocItems.value[1].id, existing.id);
  assert.equal(tocItems.value[1].title, 'Imported');
  assert.equal(tocItems.value[1].level, 3);
  assert.equal(tocItems.value[1].content, 'new body');
  assert.equal(tocItems.value[2].title, 'Second');
  assert.equal(activeTocId.value, existing.id);
  assert.equal(lastRemoved.value, null);
  assert.equal(tocStatusError.value, false);
  assert.match(tocStatus.value, /Imported 2 sections from outline\.json\./);
});
test('an outline export round-trips drafts and links', () => {
  resetOutline([
    makeItem({ title: 'Round', content: 'draft text', links: { pdfPage: 42 } }),
  ]);
  const json = exportTocJson();
  resetOutline([]);
  assert.equal(importTocJson(json, 'outline.json'), true);
  assert.equal(tocItems.value[0].title, 'Round');
  assert.equal(tocItems.value[0].content, 'draft text');
  assert.equal(tocItems.value[0].links.pdfPage, 42);
  assert.ok(tocItems.value[0].id);
});
test('importTocJson rejects malformed outline files', () => {
  resetOutline([]);
  assert.equal(importTocJson('not json'), false);
  assert.match(tocStatus.value, /not valid JSON/);
  assert.equal(tocStatusError.value, true);
  assert.equal(importTocJson(JSON.stringify({ hello: 1 })), false);
  assert.match(tocStatus.value, /not an outline export/);
  assert.equal(importTocJson(JSON.stringify(['metrics-toc'])), false);
  assert.match(tocStatus.value, /not an outline export/);
  assert.equal(importTocJson(validOutlineJson([])), false);
  assert.match(tocStatus.value, /no sections/);
  assert.equal(
    importTocJson(
      JSON.stringify({
        format: 'metrics-toc',
        version: 2,
        items: [{ title: 'X' }],
      }),
    ),
    false,
  );
  assert.match(tocStatus.value, /unsupported version/);
  assert.equal(tocItems.value.length, 0);
  // Entries without a usable title are skipped, the rest still import.
  assert.equal(
    importTocJson(validOutlineJson([{ title: 'Ok' }, { title: '   ' }])),
    true,
  );
  assert.equal(tocItems.value.length, 1);
  assert.match(tocStatus.value, /1 skipped/);
});
test('exportTocToFile reports the system save dialog outcome', async () => {
  resetOutline([makeItem({ title: 'One' })]);
  let captured = null;
  globalThis.window = {
    saveTextFile: async (name, content) => {
      captured = { name, content };
      return { name, path: '/tmp/outline.json', bytes: content.length };
    },
  };
  await exportTocToFile();
  assert.equal(captured.name, 'outline.json');
  assert.equal(JSON.parse(captured.content).format, 'metrics-toc');
  assert.match(tocStatus.value, /Outline saved to \/tmp\/outline\.json\./);
  globalThis.window = { saveTextFile: async () => ({ canceled: true }) };
  await exportTocToFile();
  assert.match(tocStatus.value, /Export was cancelled\./);
  globalThis.window = {
    saveTextFile: async () => ({ error: { message: 'disk full' } }),
  };
  await exportTocToFile();
  assert.match(tocStatus.value, /disk full/);
  assert.equal(tocStatusError.value, true);
  resetOutline([]);
  globalThis.window = {
    saveTextFile: async () => {
      throw new Error('must not be called for an empty outline');
    },
  };
  await exportTocToFile();
  assert.match(tocStatus.value, /at least one section/);
  assert.equal(tocStatusError.value, true);
  globalThis.window = {};
});
test('importTocFromFile prefers the system picker and reports outcomes', async () => {
  resetOutline([]);
  globalThis.window = {
    openTextFile: async () => ({
      name: 'outline.json',
      path: '/tmp/outline.json',
      content: validOutlineJson([{ title: 'From File' }]),
    }),
  };
  await importTocFromFile();
  assert.equal(tocItems.value.length, 1);
  assert.match(tocStatus.value, /Imported 1 section from outline\.json\./);
  resetOutline([]);
  globalThis.window = { openTextFile: async () => ({ canceled: true }) };
  await importTocFromFile();
  assert.match(tocStatus.value, /Import was cancelled\./);
  resetOutline([]);
  globalThis.window = {
    openTextFile: async () => ({ error: { message: 'unreadable' } }),
  };
  await importTocFromFile();
  assert.match(tocStatus.value, /unreadable/);
  assert.equal(tocStatusError.value, true);
  // Without the host the hidden fallback input is clicked instead.
  resetOutline([]);
  globalThis.window = {};
  let clicked = 0;
  tocImportInput.value = {
    click: () => {
      clicked += 1;
    },
  };
  await importTocFromFile();
  assert.equal(clicked, 1);
  tocImportInput.value = null;
});
test('handleTocImportFile continues the browser fallback path', async () => {
  globalThis.FileReader = class {
    readAsText(file) {
      this.result = file.__text;
      this.onload();
    }
  };
  resetOutline([]);
  let event = {
    target: {
      files: [
        {
          name: 'outline.json',
          __text: validOutlineJson([{ title: 'Picked' }]),
        },
      ],
      value: 'x',
    },
  };
  handleTocImportFile(event);
  await settle();
  assert.equal(tocItems.value.length, 1);
  assert.equal(tocItems.value[0].title, 'Picked');
  assert.equal(event.target.value, '');
  resetOutline([]);
  event = { target: { files: [], value: 'y' } };
  handleTocImportFile(event);
  assert.match(tocStatus.value, /Import was cancelled\./);
  assert.equal(event.target.value, '');
  globalThis.FileReader = class {
    readAsText() {
      this.error = new Error('boom');
      this.onerror();
    }
  };
  handleTocImportFile({ target: { files: [{ name: 'bad.json' }], value: '' } });
  await settle();
  assert.match(tocStatus.value, /could not be read/);
  assert.equal(tocStatusError.value, true);
  delete globalThis.FileReader;
});
test('exportActiveDraftToFile writes the active draft with a safe name', async () => {
  const item = makeItem({ title: 'My Chapter' });
  resetOutline([item], item.id);
  editorContent.value = 'draft text';
  editorNotice.value = '';
  let captured = null;
  globalThis.window = {
    saveTextFile: async (name, content) => {
      captured = { name, content };
      return { name, path: '/tmp/My Chapter.txt', bytes: content.length };
    },
  };
  await exportActiveDraftToFile();
  assert.equal(captured.name, 'My Chapter.txt');
  assert.equal(captured.content, 'draft text');
  assert.match(editorNotice.value, /Saved to \/tmp\/My Chapter\.txt\./);
  assert.equal(editorNoticeError.value, false);
  // A host result without a path reads as a browser download.
  globalThis.window = { saveTextFile: async (name) => ({ name }) };
  await exportActiveDraftToFile();
  assert.match(editorNotice.value, /Downloaded as My Chapter\.txt\./);
  // With no section picked the action refuses.
  resetOutline([]);
  editorContent.value = '';
  globalThis.window = {};
  await exportActiveDraftToFile();
  assert.match(editorNotice.value, /Pick a section/);
  assert.equal(editorNoticeError.value, true);
});
test('importActiveDraftFromFile replaces the active draft', async () => {
  const item = makeItem({ title: 'Sec', content: 'old body' });
  resetOutline([item], item.id);
  editorContent.value = 'old body';
  editorNotice.value = '';
  const before = persistCount();
  globalThis.window = {
    openTextFile: async () => ({
      name: 'notes.txt',
      path: '/tmp/notes.txt',
      content: 'imported body',
    }),
  };
  await importActiveDraftFromFile();
  assert.equal(editorContent.value, 'imported body');
  assert.equal(item.content, 'imported body');
  assert.ok(persistCount() > before);
  assert.match(editorNotice.value, /Draft replaced by “notes\.txt”\./);
  globalThis.window = { openTextFile: async () => ({ canceled: true }) };
  await importActiveDraftFromFile();
  assert.match(editorNotice.value, /Import was cancelled\./);
  globalThis.window = {
    openTextFile: async () => ({ error: { message: 'nope' } }),
  };
  await importActiveDraftFromFile();
  assert.match(editorNotice.value, /nope/);
  assert.equal(editorNoticeError.value, true);
  // No section picked: refuse before touching the host.
  resetOutline([]);
  editorContent.value = '';
  globalThis.window = {};
  await importActiveDraftFromFile();
  assert.match(editorNotice.value, /Pick a section/);
  // Without the host the hidden fallback input takes over.
  const active = makeItem({ title: 'Back' });
  resetOutline([active], active.id);
  editorContent.value = 'keep';
  let clicked = 0;
  editorImportInput.value = {
    click: () => {
      clicked += 1;
    },
  };
  await importActiveDraftFromFile();
  assert.equal(clicked, 1);
  editorImportInput.value = null;
});
test('handleEditorImportFile continues the browser fallback path', async () => {
  globalThis.FileReader = class {
    readAsText(file) {
      this.result = file.__text;
      this.onload();
    }
  };
  const item = makeItem({ title: 'Sec', content: 'old' });
  resetOutline([item], item.id);
  editorContent.value = 'old';
  const before = persistCount();
  const event = {
    target: {
      files: [{ name: 'chapter.txt', __text: 'file body' }],
      value: 'x',
    },
  };
  handleEditorImportFile(event);
  await settle();
  assert.equal(editorContent.value, 'file body');
  assert.equal(item.content, 'file body');
  assert.ok(persistCount() > before);
  assert.match(editorNotice.value, /Draft replaced by “chapter\.txt”\./);
  assert.equal(event.target.value, '');
  editorNotice.value = '';
  handleEditorImportFile({ target: { files: [], value: '' } });
  assert.match(editorNotice.value, /Import was cancelled\./);
  // The gate still applies on the fallback path.
  resetOutline([]);
  editorContent.value = '';
  handleEditorImportFile({ target: { files: [{ name: 'x.txt' }], value: '' } });
  await settle();
  assert.match(editorNotice.value, /Pick a section/);
  delete globalThis.FileReader;
});
/*
 * The image-link cap is enforced on write, not only when a record is read:
 * workspace.js truncates to MAX_IMAGES_PER_ITEM, so an unbounded attach used to
 * write a 65th link that the next load silently dropped.
 */
test('attaching images stops at the per-item cap instead of losing links', () => {
  tocDraftTitle.value = 'Chapter';
  addTocItem();
  const target = tocItems.value.at(-1);
  selectTocItem(target);
  for (let index = 0; index < MAX_IMAGES_PER_ITEM + 2; index++) {
    attachImageToToc({
      name: `shot-${index}.png`,
      relativePath: `a/shot-${index}.png`,
    });
  }
  assert.equal(activeTocItem.value.links.images.length, MAX_IMAGES_PER_ITEM);
  assert.match(imageStatus.value, /already links 64 images/);
});
/* The cap must survive a round trip through the schema, not just the session. */
test('a full item survives normalization and serialization unchanged', () => {
  tocDraftTitle.value = 'Chapter';
  addTocItem();
  const target = tocItems.value.at(-1);
  selectTocItem(target);
  for (let index = 0; index < MAX_IMAGES_PER_ITEM; index++) {
    attachImageToToc({
      name: `s${index}.png`,
      relativePath: `a/s${index}.png`,
    });
  }
  const state = {
    view: view.value,
    tocItems: tocItems.value,
    activeTocId: activeTocId.value,
    editor: { content: editorContent.value },
    pdf: {},
    images: {},
  };
  const restored = normalizeWorkspace(JSON.parse(serializeWorkspace(state)));
  assert.equal(restored.tocItems[0].links.images.length, MAX_IMAGES_PER_ITEM);
});
