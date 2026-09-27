/*
 * Unit tests for the TOC Manager: derived outline state, draft syncing, and
 * the link actions that reach into the reader, the viewer, and the editor.
 *
 * The session is a singleton, so every case resets the outline it touches and
 * the persistence hook it injects.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { view } from '../src/app-shell.js';
import { editorContent } from '../src/editor-session.js';
import {
  closeLightbox,
  imageFiles,
  imageStatus,
  imageStatusError,
  lightboxImage,
  selectedImageGroup,
  setImageCollection,
} from '../src/image-session.js';
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
  attachPdfPageToToc,
  configureTocOutline,
  importPdfHeadingsToToc,
  linkTarget,
  linkTargetId,
  nextTocItem,
  openLinkedImages,
  openLinkedPdfPage,
  previousTocItem,
  removeTocItem,
  saveTocItems,
  selectTocItem,
  setTocStatus,
  syncTocDraft,
  tocDraftLevel,
  tocDraftTitle,
  tocItemLabel,
  tocItems,
  tocStatus,
  tocStatusError,
} from '../src/toc-outline.js';
import { createTocItem } from '../src/workspace.js';

/* The outline focuses template elements on nextTick; Node has no document. */
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
};

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
