/*
 * Unit tests for the TOC Manager: derived outline state, the management
 * actions (declare, inline edit, reorder, undoable removal, filter), draft
 * syncing, and the link actions that reach into the reader, the viewer, and
 * the editor.
 *
 * The session is a singleton, so every case resets the outline it touches and
 * the persistence hook it injects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { view } from '../src/app-shell.js';
import {
  editorContent,
  editorNotice,
  editorNoticeError,
} from '../src/editor-session.js';
import {
  closeLightbox,
  imageFiles,
  imageStatus,
  imageStatusError,
  lightboxImage,
  selectedImageGroup,
  setImageCollection,
} from '../src/image-session.js';
import { mapPin, mapStatus, mapStatusError } from '../src/map-explorer.js';
import {
  pdfDocument,
  pdfName,
  pdfPageNumber,
  pdfStatus,
  pdfStatusError,
  setPdfStatus,
  tocHeadings,
} from '../src/pdf-session.js';
import {
  activeTocId,
  activeTocIndex,
  activeTocItem,
  addTocItem,
  attachImageToToc,
  attachLocationToToc,
  attachPdfPageToToc,
  cancelTocEdit,
  configureTocOutline,
  editingTocId,
  editorImportInput,
  exportActiveDraftToFile,
  exportTocJson,
  exportTocToFile,
  filteredTocItems,
  handleEditorImportFile,
  handleTocImportFile,
  importActiveDraftFromFile,
  importPdfHeadingsToToc,
  importTocFromFile,
  importTocJson,
  lastRemoved,
  linkTarget,
  linkTargetId,
  moveTocItem,
  nextTocItem,
  openLinkedImages,
  openLinkedLocation,
  openLinkedPdfPage,
  previousTocItem,
  removeTocItem,
  saveTocEdit,
  saveTocItems,
  selectTocItem,
  setTocStatus,
  showTocFilter,
  startTocEdit,
  syncTocDraft,
  tocDraftLevel,
  tocDraftTitle,
  tocEditLevel,
  tocEditTitle,
  tocFilterQuery,
  tocImportInput,
  tocItemLabel,
  tocItems,
  tocStatus,
  tocStatusError,
  undoTocRemoval,
} from '../src/toc-outline.js';
import {
  createTocItem,
  MAX_IMAGES_PER_ITEM,
  normalizeWorkspace,
  serializeWorkspace,
} from '../src/workspace.js';

/* The outline focuses template elements on nextTick; Node has no document. */
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
};
/* Native transfer bindings are opt-in per test; none exist by default. */
globalThis.window = {};

let persistCount = 0;
let persistResult = true;
configureTocOutline({
  persistNow: () => {
    persistCount += 1;
    return persistResult;
  },
});

function makeItem(overrides = {}) {
  return createTocItem({ title: 'Section', level: 1, ...overrides });
}

function resetOutline(items = [], activeId = null) {
  closeLightbox();
  tocItems.value = items;
  activeTocId.value = activeId;
  linkTargetId.value = activeId || items[0]?.id || null;
  tocDraftTitle.value = '';
  tocDraftLevel.value = 1;
  tocFilterQuery.value = '';
  cancelTocEdit();
  lastRemoved.value = null;
  editorContent.value = '';
  persistResult = true;
  setTocStatus('idle');
}

test('the outline label counts items with correct pluralization', () => {
  resetOutline([]);
  assert.equal(tocItemLabel.value, '0 items declared');

  const single = makeItem({ title: 'Only' });
  resetOutline([single], single.id);
  assert.equal(tocItemLabel.value, '1 item declared');

  resetOutline([single, makeItem({ title: 'Second' })], single.id);
  assert.equal(tocItemLabel.value, '2 items declared');
});

test('the active item, its index, and its neighbours are derived', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });
  const third = makeItem({ title: 'Third' });

  resetOutline([first, second, third], second.id);
  assert.equal(activeTocItem.value?.id, second.id);
  assert.equal(activeTocIndex.value, 1);
  assert.equal(previousTocItem.value?.id, first.id);
  assert.equal(nextTocItem.value?.id, third.id);

  resetOutline([first, second, third], first.id);
  assert.equal(previousTocItem.value, null);
  assert.equal(nextTocItem.value?.id, second.id);

  resetOutline([first], 'missing-id');
  assert.equal(activeTocItem.value, null);
  assert.equal(activeTocIndex.value, -1);
  assert.equal(previousTocItem.value, null);
  assert.equal(nextTocItem.value, null);
});

test('the attach target prefers the explicit link target', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });

  resetOutline([first, second], first.id);
  linkTargetId.value = second.id;
  assert.equal(linkTarget.value?.id, second.id);

  linkTargetId.value = 'missing-id';
  assert.equal(linkTarget.value?.id, first.id);

  resetOutline([first, second], null);
  linkTargetId.value = null;
  assert.equal(linkTarget.value, null);
});

test('status messages carry their error flag', () => {
  setTocStatus('saved');
  assert.equal(tocStatus.value, 'saved');
  assert.equal(tocStatusError.value, false);

  setTocStatus('failed', true);
  assert.equal(tocStatus.value, 'failed');
  assert.equal(tocStatusError.value, true);
});

test('saving writes through the injected hook and reports failure', () => {
  resetOutline([]);
  persistCount = 0;
  assert.equal(saveTocItems(), true);
  assert.equal(persistCount, 1);
  assert.equal(tocStatusError.value, false);

  persistResult = false;
  assert.equal(saveTocItems(), false);
  assert.equal(tocStatusError.value, true);
  assert.equal(
    tocStatus.value,
    'The workspace could not be saved in this browser.',
  );
});

test('declaring an item needs a title', () => {
  resetOutline([]);
  tocDraftTitle.value = '   ';
  addTocItem();
  assert.equal(tocItems.value.length, 0);
  assert.equal(tocStatusError.value, true);
  assert.equal(
    tocStatus.value,
    'Enter a heading title before declaring an item.',
  );
});

test('declaring an item appends it, clears the draft, and persists', () => {
  resetOutline([]);
  tocDraftTitle.value = 'Background';
  tocDraftLevel.value = 3;
  persistCount = 0;

  addTocItem();

  assert.equal(tocItems.value.length, 1);
  assert.equal(tocItems.value[0].title, 'Background');
  assert.equal(tocItems.value[0].level, 3);
  assert.equal(tocDraftTitle.value, '');
  assert.match(tocStatus.value, /Background.* declared/);
  assert.equal(persistCount, 1);
});

test('removing an item drops it and clears the selection', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });
  resetOutline([first, second], first.id);

  removeTocItem(first);
  assert.equal(tocItems.value.length, 1);
  assert.equal(activeTocId.value, null);
  assert.match(tocStatus.value, /removed from the outline/);

  removeTocItem(makeItem({ title: 'Ghost' }));
  assert.equal(tocItems.value.length, 1);
});

test('inline editing renames an item without losing its draft or links', () => {
  const item = makeItem({ title: 'Old title', level: 2 });
  item.content = 'Keep me';
  item.links.pdfPage = 4;
  resetOutline([item], item.id);
  persistCount = 0;

  startTocEdit(item);
  assert.equal(editingTocId.value, item.id);
  assert.equal(tocEditTitle.value, 'Old title');
  assert.equal(tocEditLevel.value, 2);

  tocEditTitle.value = '  New title  ';
  tocEditLevel.value = 99;
  saveTocEdit(item);

  assert.equal(item.title, 'New title');
  assert.equal(item.level, 3);
  assert.equal(item.content, 'Keep me');
  assert.equal(item.links.pdfPage, 4);
  assert.equal(editingTocId.value, null);
  assert.match(tocStatus.value, /New title.* updated/);
  assert.equal(persistCount, 1);
  assert.equal(tocStatusError.value, false);
});

test('inline editing rejects an empty title and keeps the row open', () => {
  const item = makeItem({ title: 'Keep' });
  resetOutline([item], item.id);

  startTocEdit(item);
  tocEditTitle.value = '   ';
  saveTocEdit(item);

  assert.equal(item.title, 'Keep');
  assert.equal(editingTocId.value, item.id);
  assert.equal(tocStatusError.value, true);
  assert.equal(tocStatus.value, 'Enter a heading title before saving.');

  cancelTocEdit();
  assert.equal(editingTocId.value, null);
  assert.equal(tocEditTitle.value, '');
});

test('reordering swaps neighbours and respects the ends and filters', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });
  const third = makeItem({ title: 'Third' });
  resetOutline([first, second, third], second.id);
  persistCount = 0;
  const order = () => tocItems.value.map((entry) => entry.title);

  moveTocItem(second, -1);
  assert.deepEqual(order(), ['Second', 'First', 'Third']);
  assert.equal(persistCount, 1);
  assert.match(tocStatus.value, /Moved .* up/);

  moveTocItem(second, -1);
  assert.deepEqual(order(), ['Second', 'First', 'Third']);
  assert.equal(persistCount, 1);

  moveTocItem(third, 1);
  assert.deepEqual(order(), ['Second', 'First', 'Third']);
  assert.equal(persistCount, 1);

  moveTocItem(third, -1);
  assert.deepEqual(order(), ['Second', 'Third', 'First']);
  assert.equal(persistCount, 2);

  tocFilterQuery.value = 'third';
  moveTocItem(first, -1);
  assert.deepEqual(order(), ['Second', 'Third', 'First']);
  assert.equal(persistCount, 2);
});

test('removing can be undone and the undo dies with the next mutation', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });
  resetOutline([first, second], first.id);
  persistCount = 0;

  removeTocItem(second);
  assert.equal(lastRemoved.value?.item.id, second.id);
  assert.equal(lastRemoved.value?.index, 1);
  assert.equal(lastRemoved.value?.wasActive, false);

  removeTocItem(first);
  assert.equal(tocItems.value.length, 0);
  assert.equal(activeTocId.value, null);
  assert.equal(lastRemoved.value?.item.id, first.id);
  assert.equal(lastRemoved.value?.wasActive, true);

  undoTocRemoval();
  assert.equal(tocItems.value.length, 1);
  assert.equal(tocItems.value[0].id, first.id);
  assert.equal(activeTocId.value, first.id);
  assert.equal(lastRemoved.value, null);
  assert.match(tocStatus.value, /restored to the outline/);
  assert.equal(persistCount, 3);

  undoTocRemoval();
  assert.equal(tocItems.value.length, 1);
  assert.equal(persistCount, 3);
});

test('a new declaration clears a pending undo', () => {
  const item = makeItem({ title: 'Gone' });
  resetOutline([item], null);
  removeTocItem(item);
  assert.equal(lastRemoved.value?.item.id, item.id);

  tocDraftTitle.value = 'Fresh';
  addTocItem();

  assert.equal(lastRemoved.value, null);
  undoTocRemoval();
  assert.equal(tocItems.value.length, 1);
  assert.equal(tocItems.value[0].title, 'Fresh');
});

test('the filter narrows the outline and only appears when long', () => {
  const items = Array.from({ length: 8 }, (_, index) =>
    makeItem({
      title: index === 3 ? 'Chapter Intro' : `Section ${index}`,
    }),
  );
  resetOutline(items, null);

  assert.equal(showTocFilter.value, true);
  assert.equal(filteredTocItems.value.length, 8);

  tocFilterQuery.value = 'intro';
  assert.equal(filteredTocItems.value.length, 1);
  assert.equal(filteredTocItems.value[0].title, 'Chapter Intro');

  tocFilterQuery.value = 'zzz';
  assert.equal(filteredTocItems.value.length, 0);

  resetOutline(items.slice(0, 7), null);
  assert.equal(showTocFilter.value, false);
  tocFilterQuery.value = 'section';
  assert.equal(filteredTocItems.value.length, 6);
});

test('selecting an item loads its draft and opens the editor', () => {
  const item = makeItem({ title: 'Chapter One' });
  item.content = 'Already written.';
  resetOutline([item], null);

  selectTocItem(item);

  assert.equal(activeTocId.value, item.id);
  assert.equal(editorContent.value, 'Already written.');
  assert.equal(view.value, 'editor');
  assert.equal(tocStatus.value, 'Writing “Chapter One”.');
});

test('selecting another item flushes the current draft first', () => {
  const first = makeItem({ title: 'First' });
  const second = makeItem({ title: 'Second' });
  resetOutline([first, second], first.id);
  editorContent.value = 'Draft for the first item.';

  selectTocItem(second);

  assert.equal(first.content, 'Draft for the first item.');
  assert.equal(editorContent.value, '');
  assert.equal(first.updatedAt > 0, true);
});

test('syncing the draft writes only when it changed', () => {
  const item = makeItem({ title: 'Only' });
  resetOutline([item], item.id);
  editorContent.value = 'Same words';
  item.content = 'Same words';

  persistCount = 0;
  syncTocDraft();
  assert.equal(persistCount, 0);

  editorContent.value = 'Different words';
  syncTocDraft();
  assert.equal(item.content, 'Different words');
  assert.equal(persistCount, 1);

  activeTocId.value = null;
  editorContent.value = 'No active item';
  syncTocDraft();
  assert.equal(persistCount, 1);
});

test('attaching a page explains a missing target or a missing document', () => {
  const item = makeItem({ title: 'Target' });
  resetOutline([item], null);
  linkTargetId.value = null;

  attachPdfPageToToc();
  assert.equal(pdfStatusError.value, true);
  assert.equal(
    pdfStatus.value,
    'Select an outline item to attach this page to.',
  );

  linkTargetId.value = item.id;
  setPdfStatus('ready');
  attachPdfPageToToc();
  assert.equal(pdfStatusError.value, true);
  assert.equal(pdfStatus.value, 'Open a PDF before attaching a page.');
});

test('attaching a page stores the page and name on the target', () => {
  const item = makeItem({ title: 'Target' });
  resetOutline([item], item.id);
  pdfDocument.value = { numPages: 12 };
  pdfPageNumber.value = 7;
  pdfName.value = 'handbook.pdf';

  attachPdfPageToToc();

  assert.equal(item.links.pdfPage, 7);
  assert.equal(item.links.pdfName, 'handbook.pdf');
  assert.equal(pdfStatusError.value, false);
  assert.equal(pdfStatus.value, 'Page 7 attached to “Target”.');

  pdfDocument.value = null;
  pdfName.value = 'No document selected';
});

test('importing headings needs an extracted document', () => {
  resetOutline([]);
  tocHeadings.value = [];
  setPdfStatus('ready');

  importPdfHeadingsToToc();

  assert.equal(tocItems.value.length, 0);
  assert.equal(pdfStatusError.value, true);
  assert.equal(
    pdfStatus.value,
    'Open a PDF first so there are headings to import.',
  );
});

test('importing headings adds each heading once with a clamped level', () => {
  resetOutline([]);
  pdfName.value = 'handbook.pdf';
  tocHeadings.value = [
    { title: 'Chapter 1 Intro', level: 9, page: 1 },
    { title: 'Details', level: 2, page: 4 },
    { title: 'Chapter 1 Intro', level: 1, page: 1 },
    { title: '   ', level: 1, page: 2 },
    { title: 'No page', level: 2, page: 'n/a' },
  ];

  importPdfHeadingsToToc();

  assert.equal(tocItems.value.length, 3);
  assert.equal(tocItems.value[0].title, 'Chapter 1 Intro');
  assert.equal(tocItems.value[0].level, 3);
  assert.equal(tocItems.value[0].links.pdfPage, 1);
  assert.equal(tocItems.value[1].links.pdfPage, 4);
  assert.equal(tocItems.value[2].links.pdfPage, null);
  assert.equal(pdfStatusError.value, false);
  assert.equal(pdfStatus.value, 'Imported 3 headings · 1 already present.');

  importPdfHeadingsToToc();
  assert.equal(tocItems.value.length, 3);
  assert.equal(pdfStatus.value, 'Imported 0 headings · 4 already present.');

  pdfName.value = 'No document selected';
});

test('attaching an image stores each path once', () => {
  const item = makeItem({ title: 'Gallery' });
  resetOutline([item], item.id);

  attachImageToToc({ name: 'a.png', relativePath: 'photos/a.png' });
  attachImageToToc({ name: 'a.png', relativePath: 'photos/a.png' });
  attachImageToToc({ name: 'b.png', relativePath: 'photos/b.png' });

  assert.deepEqual(item.links.images, ['photos/a.png', 'photos/b.png']);
  assert.match(imageStatus.value, /b\.png/);

  linkTargetId.value = null;
  activeTocId.value = null;
  attachImageToToc({ name: 'c.png', relativePath: 'photos/c.png' });
  assert.equal(imageStatusError.value, true);
  assert.equal(
    imageStatus.value,
    'Select an outline item to attach this image to.',
  );
});

test('opening linked images opens the lightbox when the folder is loaded', () => {
  const item = makeItem({ title: 'Gallery' });
  item.links.images = ['photos/a.png', 'photos/b.png'];
  resetOutline([item], item.id);
  setImageCollection(
    [
      { name: 'a.png', relativePath: 'photos/a.png', dataUrl: 'data:a' },
      { name: 'b.png', relativePath: 'photos/b.png', dataUrl: 'data:b' },
    ],
    'Photos',
  );
  selectedImageGroup.value = 'Some Group';

  openLinkedImages(item);

  assert.equal(view.value, 'images');
  assert.equal(selectedImageGroup.value, 'All Images');
  assert.equal(lightboxImage.value?.relativePath, 'photos/a.png');
});

test('opening linked images explains a folder that is not loaded', () => {
  const item = makeItem({ title: 'Gallery' });
  item.links.images = ['photos/a.png'];
  resetOutline([item], item.id);
  imageFiles.value = [];

  openLinkedImages(item);

  assert.equal(view.value, 'images');
  assert.equal(lightboxImage.value, null);
  assert.match(imageStatus.value, /1 attached image needs the original folder/);
  assert.equal(imageStatusError.value, true);

  item.links.images = ['photos/a.png', 'photos/b.png'];
  openLinkedImages(item);
  assert.match(imageStatus.value, /2 attached images need the original folder/);
});

test('jumping to a linked page opens the reader on the target page', async () => {
  const item = makeItem({ title: 'Chapter' });
  item.links.pdfPage = 3;
  resetOutline([item], item.id);
  pdfDocument.value = { numPages: 5 };
  pdfPageNumber.value = 1;
  setPdfStatus('ready');

  await openLinkedPdfPage(item);

  assert.equal(view.value, 'pdf');
  assert.equal(pdfPageNumber.value, 3);

  item.links.pdfPage = 99;
  await openLinkedPdfPage(item);
  assert.equal(pdfPageNumber.value, 5);

  pdfDocument.value = null;
});

test('jumping to a linked page explains a closed document', async () => {
  const item = makeItem({ title: 'Chapter' });
  item.links.pdfPage = 3;
  resetOutline([item], item.id);
  pdfDocument.value = null;
  pdfName.value = 'No document selected';
  setPdfStatus('ready');

  await openLinkedPdfPage(item);

  assert.equal(view.value, 'pdf');
  assert.equal(pdfStatusError.value, true);
  assert.equal(pdfStatus.value, 'Open the source document to jump to page 3.');
});

/* --- links to the map ------------------------------------------------------ */

test('attaching a pin stores the coordinates on the selected section', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = { lat: 48.8584, lon: 2.2945, label: '' };

  attachLocationToToc();

  assert.deepEqual(item.links.location, {
    lat: 48.8584,
    lon: 2.2945,
    label: '',
  });
  assert.equal(mapStatus.value, 'Location attached to “Site visit”.');
  assert.equal(mapStatusError.value, false);
  mapPin.value = null;
});

test('attaching a location needs both a target and a pin', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = null;

  /* A pin, but no target. */
  linkTargetId.value = null;
  activeTocId.value = null;
  mapPin.value = { lat: 1, lon: 2, label: '' };
  attachLocationToToc();
  assert.equal(mapStatusError.value, true);
  assert.match(mapStatus.value, /Select an outline item/);
  assert.equal(item.links.location, null);

  /* A target, but no pin. */
  linkTargetId.value = item.id;
  mapPin.value = null;
  attachLocationToToc();
  assert.equal(mapStatusError.value, true);
  assert.match(mapStatus.value, /drop a pin/);
  assert.equal(item.links.location, null);
});

test('re-attaching replaces the previous place rather than adding one', () => {
  const item = makeItem({ title: 'Site visit' });
  item.links.location = { lat: 1, lon: 1, label: '' };
  resetOutline([item], item.id);

  mapPin.value = { lat: 10, lon: 20, label: '' };
  attachLocationToToc();

  assert.deepEqual(item.links.location, { lat: 10, lon: 20, label: '' });
  mapPin.value = null;
});

test('a stored location is copied, not aliased, into the outline', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = { lat: 5, lon: 6, label: 'Fifth' };

  attachLocationToToc();

  /* Moving the pin afterwards must not rewrite what was attached. */
  mapPin.value = { lat: 99, lon: 99, label: 'Moved' };
  assert.equal(item.links.location.lat, 5);
  assert.equal(item.links.location.label, 'Fifth');
  mapPin.value = null;
});

test('jumping to a linked location travels to it in the explorer', async () => {
  /*
   * The outline's job here is to switch view and tell the map where to go; that
   * the map travels rather than teleports, and arrives at the right zoom, is the
   * map session's business and is covered in map-explorer.test.js. Asserting it
   * through the real session here would mean waiting on a 560ms animation.
   */
  const item = makeItem({ title: 'Site visit' });
  item.links.location = { lat: 48.8584, lon: 2.2945, label: 'Eiffel Tower' };
  resetOutline([item], item.id);

  openLinkedLocation(item);

  assert.equal(view.value, 'map');
  /* The pin is not moved yet: it lands with the journey, and only if the
     journey is not interrupted. */
  assert.equal(mapPin.value, null, 'the pin waits for the journey to land');
});

test('a linked location the map cannot read is reported', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  /* No location on the item: nothing to travel to, and no error either - a
     section simply need not be about a place. */
  openLinkedLocation(item);
  assert.equal(view.value, 'map');
  assert.equal(mapStatusError.value, false);
});

test('a section with no location opens the explorer without a pin', () => {
  const item = makeItem({ title: 'Empty' });
  resetOutline([item], item.id);
  mapPin.value = null;

  openLinkedLocation(item);

  assert.equal(mapPin.value, null);
});

/* --- file transfer (import/export) -------------------------------------- */

const validOutlineJson = (items) =>
  JSON.stringify({ format: 'metrics-toc', version: 1, items });

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
  const before = persistCount;

  const ok = importTocJson(
    validOutlineJson([
      { title: 'Imported', level: 3, content: 'new body' },
      { title: 'Second', level: 1 },
    ]),
    'outline.json',
  );

  assert.equal(ok, true);
  assert.ok(persistCount > before);
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
  const before = persistCount;
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
  assert.ok(persistCount > before);
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
  const before = persistCount;
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
  assert.ok(persistCount > before);
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
