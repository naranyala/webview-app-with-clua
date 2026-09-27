/*
 * PDF Reader session: document loading, page rendering, navigation, resume,
 * and the heading-extraction panel.
 *
 * Rendering state that Vue must track (name, page, zoom, status) lives in refs;
 * the canvas registry is a plain Map keyed by page number because canvases are
 * bound manually to keep re-renders cheap. WebKit drops the bitmap of a canvas
 * that was rendered while hidden, so App.vue repaints when the view returns to
 * 'pdf'.
 */
import './pdf-compat.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import { computed, nextTick, ref, shallowRef } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';

globalThis.pdfjsWorker = pdfWorker;

/* --- document identity and viewer state ---------------------------------- */

export const pdfFileInput = ref(null);
export const currentPdfUrl = ref('');
export const pdfName = ref(
  restoredWorkspace.pdf.name || 'No document selected',
);
export const pdfSessionSize = ref(restoredWorkspace.pdf.size);
export const pdfSourceUrl = ref(restoredWorkspace.pdf.url);
export const pdfDocumentId = ref(restoredWorkspace.pdf.documentId);
export const pdfStatus = ref('Choose a PDF from your system to begin reading.');
export const pdfStatusError = ref(false);
export const pdfDocument = shallowRef(null);
export const pdfContentElement = ref(null);
export const pdfLoading = ref(false);
export const pdfRenderError = ref('');
export const pdfPageNumber = ref(restoredWorkspace.pdf.page);
export const pdfPageCount = ref(0);
export const pdfZoom = ref(restoredWorkspace.pdf.zoom);
export const activePage = ref(null);

/* page number -> <canvas> element rendered for it. */
export const pdfPageCanvases = new Map();
/* Bumped to cancel an in-flight render pass (document switch or unmount). */
let pdfRenderToken = 0;
/* Guards resumePdfSession against re-entry while a restore is running. */
let pdfResumePending = false;

/* --- heading extraction panel -------------------------------------------- */

export const tocHeadings = ref([]);
export const tocCount = ref('No headings yet');
export const tocMessage = ref('Open a PDF to build its table of contents.');
export const tocState = ref('');
export const tocCached = ref(false);

/* --- status helpers ------------------------------------------------------- */

export function setPdfStatus(message, isError = false) {
  pdfStatus.value = message;
  pdfStatusError.value = isError;
}

export function setTocMessage(message, state = '') {
  tocMessage.value = message;
  tocState.value = state;
  tocHeadings.value = [];
}

/* --- extraction ----------------------------------------------------------- */

/*
 * Asks the host for headings of the open document. Without a host binding the
 * panel explains that extraction is a desktop-only feature instead of failing
 * silently.
 */
export async function loadPdfToc() {
  const extractToc = getNativeBinding('extractPdfToc');
  if (!extractToc) {
    setTocMessage('TOC extraction is available in the desktop app.');
    tocCount.value = 'No headings yet';
    return;
  }
  setTocMessage('Extracting headings and checking saved TOC…', 'loading');
  tocCount.value = 'Extracting…';
  const result = await runNativeCall(extractToc);
  if (result.error) {
    setTocMessage(
      result.error.message || 'Could not extract headings from this PDF.',
      'error',
    );
    tocCount.value = 'Extraction failed';
    return;
  }
  const headings = Array.isArray(result.headings) ? result.headings : [];
  if (headings.length === 0) {
    setTocMessage('No headings were detected in this document.', 'empty');
    tocCount.value = 'No headings detected';
    return;
  }
  tocHeadings.value = headings;
  tocCached.value = Boolean(result.cached);
  tocCount.value = `${headings.length} heading${headings.length === 1 ? '' : 's'}`;
  tocState.value = 'ready';
  tocMessage.value = '';
}

/* --- rendering ------------------------------------------------------------ */

/* Registers (or forgets) the canvas that renders one page. */
export function setPdfPageCanvas(element, pageNumber) {
  if (element) pdfPageCanvases.set(pageNumber, element);
  else pdfPageCanvases.delete(pageNumber);
}

/*
 * Repaints every registered page canvas at the current zoom. Skips canvases
 * that are no longer in the document and aborts early when a newer render pass
 * has started.
 */
export async function renderAllPdfPages() {
  if (!pdfDocument.value) return;
  const token = ++pdfRenderToken;
  const pixelRatio = window.devicePixelRatio || 1;
  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.value.numPages;
    pageNumber += 1
  ) {
    if (token !== pdfRenderToken) return;
    const canvas = pdfPageCanvases.get(pageNumber);
    if (!canvas?.isConnected) continue;
    const page = await pdfDocument.value.getPage(pageNumber);
    if (token !== pdfRenderToken) return;
    const viewport = page.getViewport({ scale: pdfZoom.value });
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const renderTask = page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    });
    try {
      await renderTask.promise;
    } catch (error) {
      if (error?.name !== 'RenderingCancelledException') throw error;
    }
  }
}

/* --- navigation ----------------------------------------------------------- */

/* Derives the current page from the scroll offset while the user reads. */
export function handlePdfScroll() {
  const content = pdfContentElement.value;
  if (!content || pdfPageCount.value === 0) return;
  const threshold = content.scrollTop + content.clientHeight * 0.25;
  let currentPage = 1;
  for (let page = 1; page <= pdfPageCount.value; page += 1) {
    const canvas = pdfPageCanvases.get(page);
    if (!canvas) continue;
    if (
      canvas.getBoundingClientRect().top -
        content.getBoundingClientRect().top +
        content.scrollTop <=
      threshold
    ) {
      currentPage = page;
    } else {
      break;
    }
  }
  activePage.value = currentPage;
  pdfPageNumber.value = currentPage;
}

/* Scrolls the reader to a page canvas (no-op when it is not rendered yet). */
export function scrollToPdfPage(page) {
  const content = pdfContentElement.value;
  const canvas = pdfPageCanvases.get(page);
  if (!content || !canvas) return;
  const top =
    canvas.getBoundingClientRect().top -
    content.getBoundingClientRect().top +
    content.scrollTop -
    16;
  content.scrollTo({ top, behavior: 'smooth' });
  activePage.value = page;
}

/* Moves by a signed page delta, clamped to the document. */
export async function changePdfPage(offset) {
  if (!pdfDocument.value) return;
  pdfPageNumber.value = Math.min(
    Math.max(pdfPageNumber.value + offset, 1),
    pdfDocument.value.numPages,
  );
  await nextTick();
  scrollToPdfPage(pdfPageNumber.value);
}

/* Jumps straight to an absolute page (outline links use this). */
export function navigateToPage(page) {
  if (!pdfDocument.value) return;
  pdfPageNumber.value = Math.min(Math.max(page, 1), pdfDocument.value.numPages);
  nextTick(() => scrollToPdfPage(pdfPageNumber.value));
}

/* --- document lifecycle --------------------------------------------------- */

/*
 * Loads a source into PDF.js, resets the canvas registry, renders the first
 * page, and kicks off heading extraction for the new document.
 */
export async function setPdfDocument(
  name,
  size,
  url,
  documentId = '',
  sourceUrl = '',
) {
  currentPdfUrl.value = url;
  pdfName.value = name;
  pdfSessionSize.value = Math.max(0, Math.floor(Number(size) || 0));
  pdfDocumentId.value = String(documentId || '');
  pdfSourceUrl.value = String(sourceUrl).startsWith('file:')
    ? String(sourceUrl)
    : '';
  pdfRenderError.value = '';
  pdfRenderToken += 1;
  pdfPageCanvases.clear();
  pdfLoading.value = true;
  pdfPageNumber.value = 1;
  pdfPageCount.value = 0;
  setPdfStatus(`Loading ${name}…`);
  try {
    if (pdfDocument.value) {
      await pdfDocument.value.destroy();
    }
    const loadingTask = pdfjsLib.getDocument({ url, withCredentials: false });
    pdfDocument.value = await loadingTask.promise;
    pdfPageCount.value = pdfDocument.value.numPages;
    await nextTick();
    await renderAllPdfPages();
    setPdfStatus(
      `${name} · ${(size / 1024 / 1024).toFixed(2)} MB · Page 1 of ${pdfPageCount.value}`,
    );
    activePage.value = 1;
    loadPdfToc();
  } catch (error) {
    pdfDocument.value = null;
    pdfRenderError.value =
      error instanceof Error ? error.message : 'The PDF could not be rendered.';
    setPdfStatus(pdfRenderError.value, true);
  } finally {
    pdfLoading.value = false;
  }
}

/* Browser fallback: validates the picked file and opens it as an object URL. */
export function handlePdfFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.type && file.type !== 'application/pdf') {
    setPdfStatus('The selected file is not a PDF.', true);
    return;
  }
  if (currentPdfUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(currentPdfUrl.value);
  }
  setPdfDocument(file.name, file.size, URL.createObjectURL(file));
  event.target.value = '';
}

/*
 * Opens the system picker when the host provides it, otherwise falls back to
 * the hidden file input. Every failure path reports through the status line.
 */
export async function openPdf() {
  const openPdfFile = getNativeBinding('openPdf');
  if (!openPdfFile) {
    pdfFileInput.value?.click();
    return;
  }
  setPdfStatus('Waiting for the system file picker…');
  const opened = await runNativeCall(openPdfFile);
  if (opened.error) {
    setPdfStatus(opened.error.message || 'Could not open the PDF.', true);
    return;
  }
  if (opened.canceled) {
    setPdfStatus('PDF selection was cancelled.');
    return;
  }
  const url = String(opened.dataUrl || opened.url || '');
  if (!url) {
    setPdfStatus('The selected PDF did not provide a readable source.', true);
    return;
  }
  await setPdfDocument(
    String(opened.name || 'document.pdf'),
    Number(opened.size || 0),
    url,
    String(opened.documentId || ''),
    String(opened.url || ''),
  );
}

/*
 * Restores the stored session after a restart. Only file:// sources can be
 * re-opened without user action; anything else asks for the file again while
 * keeping the saved page number.
 */
export async function resumePdfSession() {
  if (pdfDocument.value || pdfLoading.value || pdfResumePending) return;
  const name = pdfName.value;
  const savedPage = pdfPageNumber.value;
  if (name === 'No document selected') return;
  if (!pdfSourceUrl.value.startsWith('file:')) {
    setPdfStatus(`Re-open ${name} to resume at page ${savedPage}.`);
    return;
  }
  pdfResumePending = true;
  setPdfStatus(`Restoring ${name}…`);
  try {
    await setPdfDocument(
      name,
      pdfSessionSize.value,
      pdfSourceUrl.value,
      pdfDocumentId.value,
      pdfSourceUrl.value,
    );
    if (pdfDocument.value && savedPage > 1 && savedPage <= pdfPageCount.value) {
      pdfPageNumber.value = savedPage;
      await nextTick();
      scrollToPdfPage(savedPage);
      setPdfStatus(`${name} · page ${savedPage} of ${pdfPageCount.value}`);
    } else if (!pdfDocument.value) {
      pdfPageNumber.value = savedPage;
      setPdfStatus(
        `Could not re-open ${name} automatically. Use Browse files to pick it again.`,
        true,
      );
    }
  } finally {
    pdfResumePending = false;
  }
}

/*
 * Cancels any running render pass, drops the canvas registry, releases the
 * document, and revokes a browser object URL. Called on unmount.
 */
export function disposePdfSession() {
  pdfRenderToken += 1;
  pdfPageCanvases.clear();
  pdfDocument.value?.destroy();
  if (currentPdfUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(currentPdfUrl.value);
  }
}

/* Menu badge: what the reader would show right now. */
export const pdfBadge = computed(() => {
  if (pdfDocument.value) {
    return pdfPageCount.value > 0
      ? `${pdfName.value} · page ${pdfPageNumber.value} of ${pdfPageCount.value}`
      : pdfName.value;
  }
  if (pdfName.value !== 'No document selected') {
    return `Resume ${pdfName.value} · page ${pdfPageNumber.value}`;
  }
  return 'Open a PDF from your local system';
});
