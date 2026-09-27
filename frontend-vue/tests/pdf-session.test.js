/*
 * Unit tests for the PDF Reader session: the menu badge, status messages,
 * page navigation and scroll math, the canvas registry, session resume, and
 * the heading-extraction panel (with and without a host binding).
 *
 * Rendering itself needs a real PDF.js document and a DOM, so these cases
 * cover everything around it with a fake document and fake elements.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  activePage,
  changePdfPage,
  disposePdfSession,
  handlePdfScroll,
  loadPdfToc,
  navigateToPage,
  pdfBadge,
  pdfContentElement,
  pdfDocument,
  pdfLoading,
  pdfName,
  pdfPageCanvases,
  pdfPageCount,
  pdfPageNumber,
  pdfSourceUrl,
  pdfStatus,
  pdfStatusError,
  resumePdfSession,
  scrollToPdfPage,
  setPdfPageCanvas,
  setPdfStatus,
  setTocMessage,
  tocCached,
  tocCount,
  tocHeadings,
  tocMessage,
  tocState,
} from '../src/pdf-session.js';

const originalWindow = globalThis.window;

globalThis.window = {};

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  pdfContentElement.value = null;
  pdfPageCanvases.clear();
});

function fakeDocument(numPages) {
  let destroyed = false;
  return {
    numPages,
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
    },
  };
}

test('the menu badge reflects the session', () => {
  pdfDocument.value = null;
  pdfName.value = 'No document selected';
  assert.equal(pdfBadge.value, 'Open a PDF from your local system');

  pdfName.value = 'handbook.pdf';
  pdfPageNumber.value = 4;
  assert.equal(pdfBadge.value, 'Resume handbook.pdf · page 4');

  pdfDocument.value = fakeDocument(12);
  pdfPageCount.value = 0;
  assert.equal(pdfBadge.value, 'handbook.pdf');

  pdfPageCount.value = 12;
  assert.equal(pdfBadge.value, 'handbook.pdf · page 4 of 12');

  pdfDocument.value = null;
  pdfName.value = 'No document selected';
  pdfPageNumber.value = 1;
  pdfPageCount.value = 0;
});

test('status helpers record their error flag and reset the panel', () => {
  setPdfStatus('ready');
  assert.equal(pdfStatus.value, 'ready');
  assert.equal(pdfStatusError.value, false);

  setPdfStatus('failed', true);
  assert.equal(pdfStatusError.value, true);

  tocHeadings.value = [{ title: 'Kept until a message changes' }];
  setTocMessage('Extracting…', 'loading');
  assert.equal(tocMessage.value, 'Extracting…');
  assert.equal(tocState.value, 'loading');
  assert.deepEqual(tocHeadings.value, []);
});

test('the canvas registry keeps one canvas per page', () => {
  pdfPageCanvases.clear();
  const one = { id: 1 };
  const two = { id: 2 };

  setPdfPageCanvas(one, 1);
  setPdfPageCanvas(two, 2);
  assert.equal(pdfPageCanvases.size, 2);
  assert.equal(pdfPageCanvases.get(2), two);

  setPdfPageCanvas(null, 1);
  assert.equal(pdfPageCanvases.has(1), false);
  assert.equal(pdfPageCanvases.size, 1);

  setPdfPageCanvas(null, 99);
  assert.equal(pdfPageCanvases.size, 1);
});

test('jumping to an absolute page is clamped to the document', () => {
  pdfDocument.value = fakeDocument(3);
  pdfPageNumber.value = 1;

  navigateToPage(2);
  assert.equal(pdfPageNumber.value, 2);

  navigateToPage(-5);
  assert.equal(pdfPageNumber.value, 1);

  navigateToPage(99);
  assert.equal(pdfPageNumber.value, 3);

  pdfDocument.value = null;
  pdfPageNumber.value = 1;
  navigateToPage(2);
  assert.equal(pdfPageNumber.value, 1);
});

test('stepping through pages is clamped too', async () => {
  pdfDocument.value = fakeDocument(3);
  pdfPageNumber.value = 1;

  await changePdfPage(-1);
  assert.equal(pdfPageNumber.value, 1);

  await changePdfPage(1);
  assert.equal(pdfPageNumber.value, 2);

  pdfPageNumber.value = 3;
  await changePdfPage(1);
  assert.equal(pdfPageNumber.value, 3);

  pdfDocument.value = null;
  pdfPageNumber.value = 2;
  await changePdfPage(1);
  assert.equal(pdfPageNumber.value, 2);
});

test('scrolling to a page targets its canvas offset', () => {
  let scrollTarget = null;
  pdfPageCanvases.clear();
  pdfContentElement.value = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo(options) {
      scrollTarget = options;
    },
  };
  setPdfPageCanvas({ getBoundingClientRect: () => ({ top: 400 }) }, 3);

  scrollToPdfPage(3);

  assert.equal(scrollTarget.top, 384);
  assert.equal(activePage.value, 3);

  scrollToPdfPage(7);
  assert.equal(activePage.value, 3);
  pdfContentElement.value = null;
  scrollToPdfPage(1);
  assert.equal(activePage.value, 3);
});

test('the reader derives the visible page from the scroll offset', () => {
  pdfPageCanvases.clear();
  pdfPageCount.value = 3;
  const content = {
    scrollTop: 0,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0 }),
    scrollTo() {},
  };
  pdfContentElement.value = content;
  /* Canvas rects move with the scroll offset, as they do in the document. */
  const canvasAt = (offset) => ({
    getBoundingClientRect: () => ({ top: offset - content.scrollTop }),
  });
  setPdfPageCanvas(canvasAt(0), 1);
  setPdfPageCanvas(canvasAt(300), 2);
  setPdfPageCanvas(canvasAt(700), 3);

  handlePdfScroll();
  assert.equal(pdfPageNumber.value, 1);
  assert.equal(activePage.value, 1);

  pdfContentElement.value.scrollTop = 250;
  handlePdfScroll();
  assert.equal(pdfPageNumber.value, 2);

  pdfContentElement.value.scrollTop = 700;
  handlePdfScroll();
  assert.equal(pdfPageNumber.value, 3);

  pdfContentElement.value = null;
  handlePdfScroll();
  assert.equal(pdfPageNumber.value, 3);

  pdfContentElement.value = { scrollTop: 0, clientHeight: 100 };
  pdfPageCount.value = 0;
  handlePdfScroll();
  assert.equal(pdfPageNumber.value, 3);
  pdfContentElement.value = null;
});

test('heading extraction without a host explains itself', async () => {
  globalThis.window = {};

  await loadPdfToc();

  assert.equal(
    tocMessage.value,
    'TOC extraction is available in the desktop app.',
  );
  assert.equal(tocCount.value, 'No headings yet');
  assert.equal(tocState.value, '');
});

test('heading extraction stores what the host returned', async () => {
  globalThis.window = {
    extractPdfToc: async () => ({
      headings: [
        { title: 'Chapter 1', page: 1, level: 1 },
        { title: 'Details', page: 4, level: 2 },
      ],
      cached: true,
    }),
  };

  await loadPdfToc();

  assert.equal(tocHeadings.value.length, 2);
  assert.equal(tocCount.value, '2 headings');
  assert.equal(tocState.value, 'ready');
  assert.equal(tocMessage.value, '');
  assert.equal(tocCached.value, true);
  globalThis.window = {};
});

test('an empty or failed extraction reports why', async () => {
  globalThis.window = { extractPdfToc: async () => ({ headings: [] }) };
  await loadPdfToc();
  assert.equal(tocMessage.value, 'No headings were detected in this document.');
  assert.equal(tocState.value, 'empty');
  assert.equal(tocCount.value, 'No headings detected');

  globalThis.window = {
    extractPdfToc: async () => {
      throw new Error('The PDF could not be read.');
    },
  };
  await loadPdfToc();
  assert.equal(tocMessage.value, 'The PDF could not be read.');
  assert.equal(tocState.value, 'error');
  assert.equal(tocCount.value, 'Extraction failed');

  globalThis.window = {
    extractPdfToc: async () => ({
      error: {
        code: 'TOC_BUSY',
        message: 'A table of contents extraction is already running.',
      },
    }),
  };
  await loadPdfToc();
  assert.equal(
    tocMessage.value,
    'A table of contents extraction is already running.',
  );
  assert.equal(tocState.value, 'error');
  globalThis.window = {};
});

test('resuming explains a source that is no longer reachable', async () => {
  pdfDocument.value = null;
  pdfLoading.value = false;
  pdfName.value = 'handbook.pdf';
  pdfSourceUrl.value = 'https://example.invalid/handbook.pdf';
  pdfPageNumber.value = 6;
  setPdfStatus('ready');

  await resumePdfSession();

  assert.equal(pdfStatus.value, 'Re-open handbook.pdf to resume at page 6.');
  assert.equal(pdfStatusError.value, false);
  assert.equal(pdfDocument.value, null);
});

test('resuming does nothing without a stored document', async () => {
  pdfDocument.value = null;
  pdfLoading.value = false;
  pdfName.value = 'No document selected';
  setPdfStatus('idle');

  await resumePdfSession();

  assert.equal(pdfStatus.value, 'idle');
});

test('disposing the session cancels renders and frees the document', () => {
  const document = fakeDocument(4);
  pdfDocument.value = document;
  setPdfPageCanvas({ id: 1 }, 1);
  setPdfPageCanvas({ id: 2 }, 2);

  disposePdfSession();

  assert.equal(pdfPageCanvases.size, 0);
  assert.equal(document.destroyed, true);
  pdfDocument.value = null;
});
