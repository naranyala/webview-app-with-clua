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
import { withFileTransfer } from './file-io.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';

/*
 * The PDF Reader session. Every dependency that reaches outside the module is
 * injected — the boot snapshot, the DOM, the binding resolver, the call
 * wrapper, the scheduler, and the device pixel ratio — so
 * a test can drive paging, TOC extraction, and rendering bookkeeping without a
 * browser. The exports at the bottom are the app's single default instance.
 */
export function createPdfSession({
  boot = restoredWorkspace,
  doc = null,
  native = getNativeBinding,
  call = runNativeCall,
  defer = nextTick,
  pixelRatio = () => globalThis.window?.devicePixelRatio || 1,
  revokeUrl = (url) => globalThis.URL?.revokeObjectURL(url),
} = {}) {
  const theDoc = () => doc ?? globalThis.document;

  globalThis.pdfjsWorker = pdfWorker;

  /* --- document identity and viewer state ---------------------------------- */

  const pdfFileInput = ref(null);
  const currentPdfUrl = ref('');
  const pdfName = ref(boot.pdf.name || 'No document selected');
  const pdfSessionSize = ref(boot.pdf.size);
  const pdfSourceUrl = ref(boot.pdf.url);
  const pdfDocumentId = ref(boot.pdf.documentId);
  const pdfStatus = ref('Choose a PDF from your system to begin reading.');
  const pdfStatusError = ref(false);
  const pdfDocument = shallowRef(null);
  const pdfContentElement = ref(null);
  const pdfLoading = ref(false);
  const pdfRenderError = ref('');
  const pdfPageNumber = ref(boot.pdf.page);
  const pdfPageCount = ref(0);
  const pdfZoom = ref(boot.pdf.zoom);
  const activePage = ref(null);

  /* page number -> <canvas> element rendered for it. */
  const pdfPageCanvases = new Map();
  /* Bumped to cancel an in-flight render pass (document switch or unmount). */
  let pdfRenderToken = 0;
  /* Guards resumePdfSession against re-entry while a restore is running. */
  let pdfResumePending = false;

  /* --- heading extraction panel -------------------------------------------- */

  const tocHeadings = ref([]);
  const tocCount = ref('No headings yet');
  const tocMessage = ref('Open a PDF to build its table of contents.');
  const tocState = ref('');
  const tocCached = ref(false);

  /* --- status helpers ------------------------------------------------------- */

  function setPdfStatus(message, isError = false) {
    pdfStatus.value = message;
    pdfStatusError.value = isError;
  }

  function setTocMessage(message, state = '') {
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
  async function loadPdfToc() {
    const extractToc = native('extractPdfToc');
    if (!extractToc) {
      setTocMessage('TOC extraction is available in the desktop app.');
      tocCount.value = 'No headings yet';
      return;
    }
    setTocMessage('Extracting headings and checking saved TOC…', 'loading');
    tocCount.value = 'Extracting…';
    const result = await call(extractToc);
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
  function setPdfPageCanvas(element, pageNumber) {
    if (element) pdfPageCanvases.set(pageNumber, element);
    else pdfPageCanvases.delete(pageNumber);
  }

  /*
   * Repaints every registered page canvas at the current zoom. Skips canvases
   * that are no longer in the document and aborts early when a newer render pass
   * has started.
   */
  async function renderAllPdfPages() {
    if (!pdfDocument.value) return;
    const token = ++pdfRenderToken;
    const ratio = pixelRatio();
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
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
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
  function handlePdfScroll() {
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
  function scrollToPdfPage(page) {
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
  async function changePdfPage(offset) {
    if (!pdfDocument.value) return;
    pdfPageNumber.value = Math.min(
      Math.max(pdfPageNumber.value + offset, 1),
      pdfDocument.value.numPages,
    );
    await defer();
    scrollToPdfPage(pdfPageNumber.value);
  }

  /* Jumps straight to an absolute page (outline links use this). */
  function navigateToPage(page) {
    if (!pdfDocument.value) return;
    pdfPageNumber.value = Math.min(
      Math.max(page, 1),
      pdfDocument.value.numPages,
    );
    defer(() => scrollToPdfPage(pdfPageNumber.value));
  }

  /* --- document lifecycle --------------------------------------------------- */

  /*
   * Loads a source into PDF.js, resets the canvas registry, renders the first
   * page, and kicks off heading extraction for the new document.
   */
  async function setPdfDocument(
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
      await defer();
      await renderAllPdfPages();
      setPdfStatus(
        `${name} · ${(size / 1024 / 1024).toFixed(2)} MB · Page 1 of ${pdfPageCount.value}`,
      );
      activePage.value = 1;
      loadPdfToc();
    } catch (error) {
      pdfDocument.value = null;
      pdfRenderError.value =
        error instanceof Error
          ? error.message
          : 'The PDF could not be rendered.';
      setPdfStatus(pdfRenderError.value, true);
    } finally {
      pdfLoading.value = false;
    }
  }

  /* Browser fallback: validates the picked file and opens it as an object URL. */
  function handlePdfFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') {
      setPdfStatus('The selected file is not a PDF.', true);
      return;
    }
    if (currentPdfUrl.value.startsWith('blob:')) {
      revokeUrl(currentPdfUrl.value);
    }
    setPdfDocument(file.name, file.size, URL.createObjectURL(file));
    event.target.value = '';
  }

  /*
   * Opens the system picker when the host provides it, otherwise falls back to
   * the hidden file input. Every failure path reports through the status line.
   */
  async function openPdf() {
    const openPdfFile = native('openPdf');
    if (!openPdfFile) {
      pdfFileInput.value?.click();
      return;
    }
    const outcome = await withFileTransfer(() => call(openPdfFile), {
      report: setPdfStatus,
      messages: {
        pending: 'Waiting for the system file picker…',
        canceled: 'PDF selection was cancelled.',
        error: 'Could not open the PDF.',
      },
      handle: null,
    });
    if (outcome.status !== 'done') return;
    const opened = outcome.result;
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
  async function resumePdfSession() {
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
      if (
        pdfDocument.value &&
        savedPage > 1 &&
        savedPage <= pdfPageCount.value
      ) {
        pdfPageNumber.value = savedPage;
        await defer();
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
  function disposePdfSession() {
    pdfRenderToken += 1;
    pdfPageCanvases.clear();
    pdfDocument.value?.destroy();
    if (currentPdfUrl.value.startsWith('blob:')) {
      revokeUrl(currentPdfUrl.value);
    }
  }

  /* Menu badge: what the reader would show right now. */
  const pdfBadge = computed(() => {
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

  return {
    activePage,
    changePdfPage,
    currentPdfUrl,
    disposePdfSession,
    handlePdfFile,
    handlePdfScroll,
    loadPdfToc,
    navigateToPage,
    openPdf,
    pdfBadge,
    pdfContentElement,
    pdfDocument,
    pdfDocumentId,
    pdfFileInput,
    pdfLoading,
    pdfName,
    pdfPageCanvases,
    pdfPageCount,
    pdfPageNumber,
    pdfRenderError,
    pdfSessionSize,
    pdfSourceUrl,
    pdfStatus,
    pdfStatusError,
    pdfZoom,
    renderAllPdfPages,
    resumePdfSession,
    scrollToPdfPage,
    setPdfDocument,
    setPdfPageCanvas,
    setPdfStatus,
    setTocMessage,
    tocCached,
    tocCount,
    tocHeadings,
    tocMessage,
    tocState,
  };
}

/*
 * The app's single PDF Reader session. App.vue and toc-outline.js import these
 * bindings; tests that need isolation call createPdfSession() instead.
 */
const session = createPdfSession();
export const activePage = session.activePage;
export const changePdfPage = session.changePdfPage;
export const currentPdfUrl = session.currentPdfUrl;
export const disposePdfSession = session.disposePdfSession;
export const handlePdfFile = session.handlePdfFile;
export const handlePdfScroll = session.handlePdfScroll;
export const loadPdfToc = session.loadPdfToc;
export const navigateToPage = session.navigateToPage;
export const openPdf = session.openPdf;
export const pdfBadge = session.pdfBadge;
export const pdfContentElement = session.pdfContentElement;
export const pdfDocument = session.pdfDocument;
export const pdfDocumentId = session.pdfDocumentId;
export const pdfFileInput = session.pdfFileInput;
export const pdfLoading = session.pdfLoading;
export const pdfName = session.pdfName;
export const pdfPageCanvases = session.pdfPageCanvases;
export const pdfPageCount = session.pdfPageCount;
export const pdfPageNumber = session.pdfPageNumber;
export const pdfRenderError = session.pdfRenderError;
export const pdfSessionSize = session.pdfSessionSize;
export const pdfSourceUrl = session.pdfSourceUrl;
export const pdfStatus = session.pdfStatus;
export const pdfStatusError = session.pdfStatusError;
export const pdfZoom = session.pdfZoom;
export const renderAllPdfPages = session.renderAllPdfPages;
export const resumePdfSession = session.resumePdfSession;
export const scrollToPdfPage = session.scrollToPdfPage;
export const setPdfDocument = session.setPdfDocument;
export const setPdfPageCanvas = session.setPdfPageCanvas;
export const setPdfStatus = session.setPdfStatus;
export const setTocMessage = session.setTocMessage;
export const tocCached = session.tocCached;
export const tocCount = session.tocCount;
export const tocHeadings = session.tocHeadings;
export const tocMessage = session.tocMessage;
export const tocState = session.tocState;
