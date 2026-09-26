<script setup>
import './pdf-compat.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import { groupImages, imagesFromFileList } from './image-viewer.js';
import {
  clampLevel,
  countWords,
  createTocItem,
  hasNativeWorkspaceStore,
  loadWorkspace,
  loadWorkspaceNative,
  outlineSummary,
  saveWorkspace,
  saveWorkspaceNative,
  serializeWorkspace,
} from './workspace.js';

globalThis.pdfjsWorker = pdfWorker;
const getOpenPdf = () => {
  if (typeof window.openPdf === 'function') return window.openPdf;
  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return () => window.__webview__.call('openPdf');
  }
  return null;
};
const getExtractPdfToc = () => {
  if (typeof window.extractPdfToc === 'function') return window.extractPdfToc;
  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return () => window.__webview__.call('extractPdfToc');
  }
  return null;
};
const getOpenImageDirectory = () => {
  if (typeof window.openImageDirectory === 'function')
    return window.openImageDirectory;
  if (window.__webview__ && typeof window.__webview__.call === 'function') {
    return () => window.__webview__.call('openImageDirectory');
  }
  return null;
};

const restoredWorkspace = loadWorkspace();
let userInteracted = false;

const view = ref(restoredWorkspace.view);
const editorContent = ref(restoredWorkspace.editor.content);
const cursorPosition = ref('Line 1, Col 1');
const editorInput = ref(null);

const pdfFileInput = ref(null);
const currentPdfUrl = ref('');
const pdfName = ref(restoredWorkspace.pdf.name || 'No document selected');
const pdfSessionSize = ref(restoredWorkspace.pdf.size);
const pdfSourceUrl = ref(restoredWorkspace.pdf.url);
const pdfDocumentId = ref(restoredWorkspace.pdf.documentId);
const pdfStatus = ref('Choose a PDF from your system to begin reading.');
const pdfStatusError = ref(false);
const pdfDocument = shallowRef(null);
const pdfContentElement = ref(null);
const pdfPageCanvases = new Map();
const pdfLoading = ref(false);
const pdfRenderError = ref('');
const pdfPageNumber = ref(restoredWorkspace.pdf.page);
const pdfPageCount = ref(0);
const pdfZoom = ref(restoredWorkspace.pdf.zoom);
let pdfRenderToken = 0;
const tocHeadings = ref([]);
const tocCount = ref('No headings yet');
const tocMessage = ref('Open a PDF to build its table of contents.');
const tocState = ref('');
const tocCached = ref(false);
const activePage = ref(null);
const persistenceMode = ref(hasNativeWorkspaceStore() ? 'native' : 'local');

const tocItems = ref(restoredWorkspace.tocItems);
const activeTocId = ref(
  restoredWorkspace.tocItems.some(
    (item) => item.id === restoredWorkspace.activeTocId,
  )
    ? restoredWorkspace.activeTocId
    : null,
);
const linkTargetId = ref(
  activeTocId.value || restoredWorkspace.tocItems[0]?.id || null,
);
const tocDraftTitle = ref('');
const tocDraftLevel = ref(1);
const tocStatus = ref(
  'Declare an outline item, then select it to start writing.',
);
const tocStatusError = ref(false);

const activeTocItem = computed(
  () => tocItems.value.find((item) => item.id === activeTocId.value) || null,
);
const documentTitle = computed(() =>
  activeTocItem.value ? activeTocItem.value.title : 'untitled.txt',
);
const tocItemLabel = computed(
  () =>
    `${tocItems.value.length} item${tocItems.value.length === 1 ? '' : 's'} declared`,
);
const activeTocIndex = computed(() =>
  tocItems.value.findIndex((item) => item.id === activeTocId.value),
);
const previousTocItem = computed(() =>
  activeTocIndex.value > 0 ? tocItems.value[activeTocIndex.value - 1] : null,
);
const nextTocItem = computed(() =>
  activeTocIndex.value >= 0 && activeTocIndex.value < tocItems.value.length - 1
    ? tocItems.value[activeTocIndex.value + 1]
    : null,
);
const editorWordCount = computed(() => countWords(editorContent.value));
const outlineSummaryState = computed(() => outlineSummary(tocItems.value));
const outlineBadge = computed(() => {
  const { total, written } = outlineSummaryState.value;
  if (total === 0) return 'Declare outline items, then write each section';
  return `${total} item${total === 1 ? '' : 's'} declared · ${written} written`;
});
const editorBadge = computed(() => {
  if (activeTocItem.value) {
    return `Writing “${activeTocItem.value.title}” · ${editorWordCount.value} words`;
  }
  if (editorWordCount.value > 0) {
    return `${editorWordCount.value} words in an untitled draft`;
  }
  return 'Write each section of your outline';
});
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
const imagesBadge = computed(() => {
  if (imageFiles.value.length > 0) {
    const count = `${imageFiles.value.length} image${imageFiles.value.length === 1 ? '' : 's'}`;
    return `${imageDirectoryName.value || 'Folder'} · ${count}`;
  }
  if (imageDirectoryName.value) {
    return `${imageDirectoryName.value} · re-select to reload`;
  }
  return 'Browse images grouped by folder';
});
const linkTarget = computed(
  () =>
    tocItems.value.find((item) => item.id === linkTargetId.value) ||
    activeTocItem.value ||
    null,
);
const documentStatus = computed(() => {
  const words =
    editorWordCount.value === 0
      ? 'Empty document'
      : `${editorWordCount.value} word${editorWordCount.value === 1 ? '' : 's'}`;
  if (activeTocIndex.value < 0) {
    return tocItems.value.length > 0
      ? `${words} · pick a section in Outline`
      : `${words} · declare a section to start writing`;
  }
  return [
    `Item ${activeTocIndex.value + 1} of ${tocItems.value.length}`,
    words,
    saveLabel.value,
  ].join(' · ');
});

const saveLabel = computed(() => {
  if (persistenceMode.value === 'native') return 'saved to disk';
  if (persistenceMode.value === 'local') return 'auto-saved';
  return 'not saved';
});

const imageDirectoryInput = ref(null);
const imageDirectoryName = ref(restoredWorkspace.images.directoryName);
const imageGroups = ref([]);
const imageFiles = ref([]);
const selectedImageGroup = ref(restoredWorkspace.images.selectedGroup);
const imageStatus = ref('Choose a parent directory to find images.');
const imageStatusError = ref(false);
const imageLoading = ref(false);
const lightboxImage = ref(null);
const lightboxIndex = ref(-1);
const visibleImages = computed(() => {
  if (selectedImageGroup.value === 'All Images') return imageFiles.value;
  return (
    imageGroups.value.find((group) => group.name === selectedImageGroup.value)
      ?.images || []
  );
});
const activeLightboxImage = computed(() =>
  lightboxImage.value ? visibleImages.value[lightboxIndex.value] : null,
);

function selectView(nextView) {
  userInteracted = true;
  if (view.value === 'editor' && nextView !== 'editor') syncTocDraft();
  view.value = nextView;
  if (nextView === 'editor') {
    nextTick(() => editorInput.value?.focus());
  }
  if (nextView === 'pdf' && !pdfDocument.value && pdfSourceUrl.value) {
    resumePdfSession();
  }
}

function setTocStatus(message, isError = false) {
  tocStatus.value = message;
  tocStatusError.value = isError;
}

function workspaceState() {
  return {
    view: view.value,
    tocItems: tocItems.value,
    activeTocId: activeTocId.value,
    editor: { content: editorContent.value },
    pdf: {
      name: pdfName.value,
      size: pdfSessionSize.value,
      url: pdfSourceUrl.value,
      documentId: pdfDocumentId.value,
      page: pdfPageNumber.value,
      zoom: pdfZoom.value,
    },
    images: {
      directoryName: imageDirectoryName.value,
      selectedGroup: selectedImageGroup.value,
    },
  };
}

let workspaceSaveTimer = 0;

function persistWorkspace() {
  const state = { ...workspaceState(), savedAt: Date.now() };
  const serialized = serializeWorkspace(state);
  const savedLocally = saveWorkspace(state);
  if (!hasNativeWorkspaceStore()) {
    persistenceMode.value = savedLocally ? 'local' : 'none';
    return savedLocally;
  }
  saveWorkspaceNative(serialized).then((savedNatively) => {
    if (savedNatively) {
      persistenceMode.value = 'native';
      return;
    }
    persistenceMode.value = savedLocally ? 'local' : 'none';
    if (!savedLocally) {
      tocStatusError.value = true;
      tocStatus.value = 'The workspace could not be saved to this device.';
    }
  });
  // The native write finishes later; failures surface through
  // persistenceMode and the TOC status rather than this return value.
  return true;
}

function flushWorkspace() {
  if (workspaceSaveTimer) {
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = 0;
  }
  return persistWorkspace();
}

function scheduleWorkspaceSave() {
  if (workspaceSaveTimer) clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(flushWorkspace, 250);
}

function saveTocItems() {
  userInteracted = true;
  const saved = persistWorkspace();
  tocStatusError.value = !saved;
  if (!saved) {
    tocStatus.value = 'The workspace could not be saved in this browser.';
  }
  return saved;
}

watch(
  [
    view,
    editorContent,
    tocItems,
    activeTocId,
    pdfName,
    pdfSessionSize,
    pdfSourceUrl,
    pdfDocumentId,
    pdfPageNumber,
    pdfZoom,
    imageDirectoryName,
    selectedImageGroup,
  ],
  scheduleWorkspaceSave,
  { deep: true },
);

watch(activeTocId, (value) => {
  if (value) linkTargetId.value = value;
});

function syncTocDraft() {
  const item = activeTocItem.value;
  if (!item || item.content === editorContent.value) return;
  userInteracted = true;
  item.content = editorContent.value;
  item.updatedAt = Date.now();
  scheduleWorkspaceSave();
}

function addTocItem() {
  const item = createTocItem({
    title: tocDraftTitle.value,
    level: tocDraftLevel.value,
  });
  if (!item) {
    setTocStatus('Enter a heading title before declaring an item.', true);
    return;
  }
  tocItems.value.push(item);
  tocDraftTitle.value = '';
  if (saveTocItems()) setTocStatus(`“${item.title}” declared.`);
  nextTick(() => document.getElementById('toc-title-input')?.focus());
}

function removeTocItem(item) {
  const index = tocItems.value.findIndex((entry) => entry.id === item.id);
  if (index < 0) return;
  tocItems.value.splice(index, 1);
  if (activeTocId.value === item.id) activeTocId.value = null;
  if (saveTocItems()) setTocStatus(`“${item.title}” removed from the outline.`);
}

function selectTocItem(item) {
  syncTocDraft();
  activeTocId.value = item.id;
  editorContent.value = item.content ?? '';
  selectView('editor');
  nextTick(() => {
    updateCursor();
    editorInput.value?.focus();
  });
  setTocStatus(`Writing “${item.title}”.`);
}

function attachPdfPageToToc() {
  const target = linkTarget.value;
  if (!target) {
    setPdfStatus('Select an outline item to attach this page to.', true);
    return;
  }
  if (!pdfDocument.value) {
    setPdfStatus('Open a PDF before attaching a page.', true);
    return;
  }
  target.links.pdfPage = pdfPageNumber.value;
  target.links.pdfName = pdfName.value;
  target.updatedAt = Date.now();
  if (saveTocItems()) {
    setPdfStatus(`Page ${pdfPageNumber.value} attached to “${target.title}”.`);
  }
}

function importPdfHeadingsToToc() {
  const headings = tocHeadings.value;
  if (headings.length === 0) {
    setPdfStatus('Open a PDF first so there are headings to import.', true);
    return;
  }
  let added = 0;
  let skipped = 0;
  for (const heading of headings) {
    const title = String(heading?.title ?? '')
      .trim()
      .slice(0, 120);
    if (!title) continue;
    const page = Number.isFinite(Number(heading.page))
      ? Math.max(1, Math.floor(Number(heading.page)))
      : null;
    const duplicate =
      page !== null &&
      tocItems.value.some(
        (item) => item.title === title && item.links.pdfPage === page,
      );
    if (duplicate) {
      skipped += 1;
      continue;
    }
    const item = createTocItem({
      title,
      level: clampLevel(heading.level),
      links: { pdfPage: page, pdfName: pdfName.value },
    });
    if (!item) continue;
    tocItems.value.push(item);
    added += 1;
  }
  if (saveTocItems()) {
    const suffix = skipped > 0 ? ` · ${skipped} already present` : '';
    setPdfStatus(
      `Imported ${added} heading${added === 1 ? '' : 's'}${suffix}.`,
    );
  }
}

async function openLinkedPdfPage(item) {
  const page = item?.links?.pdfPage;
  if (!page) return;
  selectView('pdf');
  if (!pdfDocument.value) await resumePdfSession();
  if (pdfDocument.value) {
    navigateToPage(page);
  } else {
    setPdfStatus(`Open the source document to jump to page ${page}.`, true);
  }
}

function attachImageToToc(image) {
  const target = linkTarget.value;
  const path = image?.relativePath;
  if (!target || !path) {
    setImageStatus('Select an outline item to attach this image to.', true);
    return;
  }
  if (!target.links.images.includes(path)) target.links.images.push(path);
  target.updatedAt = Date.now();
  if (saveTocItems()) {
    setImageStatus(`“${image.name}” attached to “${target.title}”.`);
  }
}

function openLinkedImages(item) {
  const paths = item?.links?.images || [];
  if (paths.length === 0) return;
  selectView('images');
  const resolved = paths
    .map((path) =>
      imageFiles.value.find((image) => image.relativePath === path),
    )
    .filter(Boolean);
  if (resolved.length > 0) {
    selectedImageGroup.value = 'All Images';
    openLightbox(resolved[0]);
    return;
  }
  setImageStatus(
    `${paths.length} attached image${paths.length === 1 ? '' : 's'} need the original folder to be selected again.`,
    true,
  );
}

function updateCursor() {
  const input = editorInput.value;
  if (!input) return;
  const lines = input.value.slice(0, input.selectionStart ?? 0).split('\n');
  cursorPosition.value = `Line ${lines.length}, Col ${(lines.at(-1)?.length ?? 0) + 1}`;
}

function setPdfStatus(message, isError = false) {
  pdfStatus.value = message;
  pdfStatusError.value = isError;
}

function setTocMessage(message, state = '') {
  tocMessage.value = message;
  tocState.value = state;
  tocHeadings.value = [];
}

async function loadPdfToc() {
  const extractToc = getExtractPdfToc();
  if (!extractToc) {
    setTocMessage('TOC extraction is available in the desktop app.');
    tocCount.value = 'No headings yet';
    return;
  }
  setTocMessage('Extracting headings and checking saved TOC…', 'loading');
  tocCount.value = 'Extracting…';
  try {
    const result = await extractToc();
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
  } catch (error) {
    setTocMessage(
      error instanceof Error
        ? error.message
        : 'Could not extract headings from this PDF.',
      'error',
    );
    tocCount.value = 'Extraction failed';
  }
}

function setPdfPageCanvas(element, pageNumber) {
  if (element) pdfPageCanvases.set(pageNumber, element);
}

async function renderAllPdfPages() {
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
    if (!canvas) continue;
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

async function changePdfPage(offset) {
  if (!pdfDocument.value) return;
  pdfPageNumber.value = Math.min(
    Math.max(pdfPageNumber.value + offset, 1),
    pdfDocument.value.numPages,
  );
  await nextTick();
  scrollToPdfPage(pdfPageNumber.value);
}

function navigateToPage(page) {
  if (!pdfDocument.value) return;
  pdfPageNumber.value = Math.min(Math.max(page, 1), pdfDocument.value.numPages);
  nextTick(() => scrollToPdfPage(pdfPageNumber.value));
}

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

function handlePdfFile(event) {
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

async function openPdf() {
  const openPdfFile = getOpenPdf();
  if (!openPdfFile) {
    pdfFileInput.value?.click();
    return;
  }
  setPdfStatus('Waiting for the system file picker…');
  try {
    const opened = await openPdfFile();
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
  } catch (error) {
    setPdfStatus(
      error instanceof Error ? error.message : 'Could not open the PDF.',
      true,
    );
  }
}

let pdfResumePending = false;

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

function setImageStatus(message, isError = false) {
  imageStatus.value = message;
  imageStatusError.value = isError;
}

function setImageCollection(images, directoryName) {
  const normalized = Array.isArray(images)
    ? images.filter((image) => image?.dataUrl)
    : [];
  imageFiles.value = normalized;
  imageGroups.value = groupImages(normalized);
  const wantedGroup = selectedImageGroup.value;
  selectedImageGroup.value = imageGroups.value.some(
    (group) => group.name === wantedGroup,
  )
    ? wantedGroup
    : 'All Images';
  imageDirectoryName.value = directoryName || 'Selected directory';
  setImageStatus(
    `${normalized.length} image${normalized.length === 1 ? '' : 's'} found.`,
  );
}

function openLightbox(image) {
  lightboxIndex.value = visibleImages.value.indexOf(image);
  if (lightboxIndex.value >= 0) {
    lightboxImage.value = image;
    nextTick(() => document.querySelector('.lightbox')?.focus());
  }
}

function changeLightbox(offset) {
  if (visibleImages.value.length === 0) return;
  lightboxIndex.value =
    (lightboxIndex.value + offset + visibleImages.value.length) %
    visibleImages.value.length;
  lightboxImage.value = visibleImages.value[lightboxIndex.value];
}

function closeLightbox() {
  lightboxImage.value = null;
  lightboxIndex.value = -1;
}

function handleLightboxKeydown(event) {
  if (!lightboxImage.value) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') changeLightbox(-1);
  if (event.key === 'ArrowRight') changeLightbox(1);
}

async function loadBrowserImageDirectory(event) {
  const files = event.target.files;
  if (!files?.length) return;
  imageLoading.value = true;
  setImageStatus('Reading images…');
  try {
    const result = await imagesFromFileList(files);
    setImageCollection(
      result.images,
      files[0].webkitRelativePath?.split('/')[0] || 'Selected directory',
    );
    const skipped = result.skipped + result.oversized;
    if (skipped > 0)
      setImageStatus(
        `${result.images.length} images loaded; ${skipped} skipped by browser limits.`,
      );
    else if (result.images.length === 0)
      setImageStatus('No supported images were found in this directory.', true);
  } catch (error) {
    setImageStatus(
      error instanceof Error
        ? error.message
        : 'Could not read the selected images.',
      true,
    );
  } finally {
    imageLoading.value = false;
    event.target.value = '';
  }
}

async function openImageDirectory() {
  const openDirectory = getOpenImageDirectory();
  if (!openDirectory) {
    imageDirectoryInput.value?.click();
    return;
  }
  imageLoading.value = true;
  setImageStatus('Waiting for the system directory picker…');
  try {
    const result = await openDirectory();
    if (result.error) {
      setImageStatus(
        result.error.message || 'Could not open the image directory.',
        true,
      );
      return;
    }
    if (result.canceled) {
      setImageStatus('Directory selection was cancelled.');
      return;
    }
    const images = Array.isArray(result.images) ? result.images : [];
    setImageCollection(images, result.name || 'Selected directory');
    if (images.length === 0)
      setImageStatus(
        'No supported images were found within the directory limits.',
        true,
      );
  } catch (error) {
    setImageStatus(
      error instanceof Error
        ? error.message
        : 'Could not open the image directory.',
      true,
    );
  } finally {
    imageLoading.value = false;
  }
}

function applyWorkspace(snapshot) {
  if (!snapshot) return false;
  const activeId = snapshot.tocItems.some(
    (item) => item.id === snapshot.activeTocId,
  )
    ? snapshot.activeTocId
    : null;
  view.value = snapshot.view;
  tocItems.value = snapshot.tocItems;
  activeTocId.value = activeId;
  linkTargetId.value = activeId || snapshot.tocItems[0]?.id || null;
  editorContent.value = snapshot.editor.content;
  pdfName.value = snapshot.pdf.name || 'No document selected';
  pdfSessionSize.value = snapshot.pdf.size;
  pdfSourceUrl.value = snapshot.pdf.url;
  pdfDocumentId.value = snapshot.pdf.documentId;
  pdfPageNumber.value = snapshot.pdf.page;
  pdfZoom.value = snapshot.pdf.zoom;
  imageDirectoryName.value = snapshot.images.directoryName;
  selectedImageGroup.value = snapshot.images.selectedGroup;
  return true;
}

async function hydrateNativeWorkspace() {
  if (!hasNativeWorkspaceStore() || userInteracted) return false;
  const snapshot = await loadWorkspaceNative();
  if (!snapshot || userInteracted) return false;
  if (snapshot.savedAt < restoredWorkspace.savedAt) return false;
  return applyWorkspace(snapshot);
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') flushWorkspace();
}

onMounted(async () => {
  const savedLocally = saveWorkspace({
    ...workspaceState(),
    savedAt: Date.now(),
  });
  if (hasNativeWorkspaceStore()) {
    persistenceMode.value = 'native';
    await hydrateNativeWorkspace();
  } else {
    persistenceMode.value = savedLocally ? 'local' : 'none';
  }

  if (view.value === 'pdf' && pdfSourceUrl.value) resumePdfSession();
  if (
    view.value === 'images' &&
    imageDirectoryName.value &&
    imageFiles.value.length === 0
  ) {
    setImageStatus(
      `${imageDirectoryName.value}: select the folder again to reload its images.`,
    );
  }
  if (view.value === 'editor') {
    nextTick(() => editorInput.value?.focus());
  }
});

window.addEventListener('pagehide', flushWorkspace);
window.addEventListener('beforeunload', flushWorkspace);
document.addEventListener('visibilitychange', handleVisibilityChange);

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', flushWorkspace);
  window.removeEventListener('beforeunload', flushWorkspace);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  flushWorkspace();
  pdfRenderToken += 1;
  pdfPageCanvases.clear();
  pdfDocument.value?.destroy();
  if (currentPdfUrl.value.startsWith('blob:')) {
    URL.revokeObjectURL(currentPdfUrl.value);
  }
});
</script>

<template>
  <main class="app-shell" :class="{ 'pdf-active': view === 'pdf', 'image-active': view === 'images' }">
    <header class="launcher-header">
      <div class="brand">
        <span class="brand-mark">N</span>
        <div>
          <span class="brand-name">Native Workspace</span>
          <span class="brand-subtitle">Local tools, one workspace</span>
        </div>
      </div>
      <button class="toolbar-button subtle" id="back-to-menu" type="button" @click="selectView('menu')">
        All apps
      </button>
    </header>

    <section v-show="view === 'menu'" class="app-menu" data-view="menu" aria-label="Application menu">
      <div class="menu-heading">
        <span>APPLICATIONS</span>
        <h1>What would you like to open?</h1>
        <p>Choose a local tool to get started.</p>
      </div>
      <div class="app-grid">
        <button class="app-card" data-app="editor" type="button" @click="selectView('editor')">
          <span class="app-icon text-icon" aria-hidden="true">Aa</span>
          <span class="app-card-copy">
            <strong>Text Editor</strong>
            <small>{{ editorBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="pdf" type="button" @click="selectView('pdf')">
          <span class="app-icon pdf-icon" aria-hidden="true">PDF</span>
          <span class="app-card-copy">
            <strong>PDF Reader</strong>
            <small>{{ pdfBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="images" type="button" @click="selectView('images')">
          <span class="app-icon image-icon" aria-hidden="true">IMG</span>
          <span class="app-card-copy">
            <strong>Image Viewer</strong>
            <small>{{ imagesBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
        <button class="app-card" data-app="toc" type="button" @click="selectView('toc')">
          <span class="app-icon toc-manager-icon" aria-hidden="true">TOC</span>
          <span class="app-card-copy">
            <strong>TOC Manager</strong>
            <small>{{ outlineBadge }}</small>
          </span>
          <span class="app-card-arrow" aria-hidden="true">›</span>
        </button>
      </div>
    </section>

    <section v-show="view === 'toc'" class="toc-manager" data-view="toc" aria-label="TOC manager application">
      <header class="toc-manager-toolbar">
        <div>
          <span class="toc-manager-eyebrow">TOC MANAGER</span>
          <strong id="toc-manager-count">{{ tocItemLabel }}</strong>
        </div>
        <div class="toc-manager-actions">
          <span id="toc-manager-status" class="toc-manager-status" :class="{ error: tocStatusError }" aria-live="polite">{{ tocStatus }}</span>
          <button class="toolbar-button subtle" id="resume-writing" type="button" :disabled="!activeTocId" @click="selectView('editor')">Resume writing</button>
        </div>
      </header>

      <div class="toc-manager-body">
        <form class="toc-declare" @submit.prevent="addTocItem">
          <div class="toc-declare-heading">
            <span>DECLARE</span>
            <strong>New outline item</strong>
          </div>
          <label for="toc-title-input">Heading title</label>
          <input
            id="toc-title-input"
            v-model="tocDraftTitle"
            type="text"
            maxlength="120"
            autocomplete="off"
            placeholder="Chapter 1 · Introduction"
          />
          <label for="toc-level-input">Level</label>
          <select id="toc-level-input" v-model="tocDraftLevel">
            <option :value="1">Level 1 · Chapter</option>
            <option :value="2">Level 2 · Section</option>
            <option :value="3">Level 3 · Subsection</option>
          </select>
          <button class="toolbar-button primary" type="submit">Declare item</button>
          <p class="toc-declare-hint">
            Selecting an item opens it in the Text Editor. Every draft is stored per item in this
            browser.
          </p>
        </form>

        <div class="toc-outline">
          <div class="toc-outline-heading">
            <span>DECLARED ITEMS</span>
            <span>Select an item to write</span>
          </div>
          <ul v-if="tocItems.length" class="toc-outline-list">
            <li
              v-for="item in tocItems"
              :key="item.id"
              class="toc-outline-item"
              :class="{ active: activeTocId === item.id }"
              :style="{ '--toc-level': item.level }"
            >
              <button class="toc-outline-select" type="button" @click="selectTocItem(item)">
                <span class="toc-outline-title">{{ item.title }}</span>
                <small>{{ countWords(item.content) }} word{{ countWords(item.content) === 1 ? '' : 's' }} · {{ item.content ? 'draft saved' : 'no draft yet' }}</small>
              </button>
              <div class="toc-outline-meta">
                <span class="toc-outline-level">H{{ item.level }}</span>
                <button v-if="item.links.pdfPage" class="toc-outline-link" type="button" :title="`Open ${item.links.pdfName || 'the PDF'} at page ${item.links.pdfPage}`" @click="openLinkedPdfPage(item)">p.{{ item.links.pdfPage }}</button>
                <button v-if="item.links.images.length" class="toc-outline-link" type="button" :title="`${item.links.images.length} attached image(s)`" @click="openLinkedImages(item)">IMG {{ item.links.images.length }}</button>
                <button class="toc-outline-remove" type="button" :aria-label="`Remove ${item.title}`" @click="removeTocItem(item)">×</button>
              </div>
            </li>
          </ul>
          <div v-else class="toc-outline-empty">
            <span class="toc-outline-empty-icon" aria-hidden="true">TOC</span>
            <h2>No outline items yet</h2>
            <p>Declare your first heading, then select it to start writing that section in the Text Editor.</p>
          </div>
        </div>
      </div>
    </section>

    <section v-show="view === 'editor'" class="editor-app" data-view="editor" aria-label="Text editor application">
      <header class="topbar">
        <div class="topbar-side">
          <button class="toolbar-button subtle" id="back-to-outline" type="button" @click="selectView('toc')">‹ Outline</button>
        </div>
        <div class="document-title" aria-live="polite">
          <span v-if="activeTocItem" class="document-level">H{{ activeTocItem.level }}</span>
          <span id="document-title-text">{{ documentTitle }}</span>
        </div>
        <div class="top-actions">
          <button v-if="activeTocItem?.links?.pdfPage" class="toolbar-button subtle" id="open-linked-pdf" type="button" @click="openLinkedPdfPage(activeTocItem)">PDF p.{{ activeTocItem.links.pdfPage }}</button>
          <button v-if="activeTocItem" class="toolbar-button subtle" id="previous-outline-item" type="button" :disabled="!previousTocItem" @click="previousTocItem && selectTocItem(previousTocItem)">‹ Prev</button>
          <button v-if="activeTocItem" class="toolbar-button subtle" id="next-outline-item" type="button" :disabled="!nextTocItem" @click="nextTocItem && selectTocItem(nextTocItem)">Next ›</button>
        </div>
      </header>

      <div class="editor-pane">
        <label class="sr-only" for="values">Document text</label>
        <textarea
          id="values"
          ref="editorInput"
          :value="editorContent"
          spellcheck="true"
          placeholder="Start writing…"
          aria-describedby="document-status"
          @input="editorContent = $event.target.value; updateCursor(); syncTocDraft()"
          @click="updateCursor"
          @keyup="updateCursor"
        />
        <div class="editor-footer">
          <span id="document-status">{{ documentStatus }}</span>
          <span id="cursor-position">{{ cursorPosition }}</span>
        </div>
      </div>
    </section>

    <section v-show="view === 'images'" class="image-app" data-view="images" aria-label="Image viewer application">
      <header class="image-toolbar">
        <div>
          <span class="image-eyebrow">IMAGE VIEWER</span>
          <strong>{{ imageDirectoryName || 'Choose an image directory' }}</strong>
        </div>
        <div class="image-actions">
          <span id="image-status" class="image-status" :class="{ error: imageStatusError }" aria-live="polite">{{ imageStatus }}</span>
          <button class="toolbar-button primary" id="open-image-directory" type="button" :disabled="imageLoading" @click="openImageDirectory">Choose directory</button>
        </div>
      </header>
      <aside class="image-sidebar" aria-label="Image folders">
        <div class="image-sidebar-heading">FOLDERS</div>
        <button
          v-for="group in imageGroups"
          :key="group.name"
          class="image-group-button"
          :class="{ active: selectedImageGroup === group.name }"
          type="button"
          @click="selectedImageGroup = group.name; closeLightbox()"
        >
          <span>{{ group.name }}</span><small>{{ group.images.length }}</small>
        </button>
      </aside>
      <div class="image-content">
        <input
          id="image-directory-input"
          ref="imageDirectoryInput"
          class="sr-only"
          type="file"
          webkitdirectory
          multiple
          accept="image/*,.avif,.heic,.heif,.svg,.tif,.tiff"
          @change="loadBrowserImageDirectory"
        />
        <div v-if="!imageFiles.length" class="image-empty">
          <span class="image-large-icon" aria-hidden="true">IMG</span>
          <h2>Browse a folder of images</h2>
          <p>Select a parent directory. Inner folders become categories in the sidebar.</p>
          <button class="toolbar-button primary" id="browse-image-directory" type="button" @click="openImageDirectory">Choose directory</button>
        </div>
        <div v-else class="image-grid" aria-label="Image thumbnails">
          <button v-for="image in visibleImages" :key="image.relativePath" class="image-thumbnail" type="button" @click="openLightbox(image)">
            <img :src="image.dataUrl" :alt="image.name" loading="lazy" />
            <span :title="image.relativePath">{{ image.name }}</span>
          </button>
        </div>
      </div>
    </section>

    <section v-show="view === 'pdf'" class="pdf-app" data-view="pdf" aria-label="PDF reader application">
      <header class="pdf-toolbar">
        <div>
          <span class="pdf-eyebrow">PDF READER</span>
          <strong id="pdf-name">{{ pdfName }}</strong>
        </div>
        <div class="pdf-actions">
          <span id="pdf-status" class="pdf-status" :class="{ error: pdfStatusError }" aria-live="polite">{{ pdfStatus }}</span>
          <button class="toolbar-button primary" id="open-pdf" type="button" @click="openPdf">Open PDF</button>
        </div>
      </header>
      <aside class="toc-sidebar" aria-label="Document table of contents">
        <div class="toc-heading">
          <span>CONTENTS</span>
          <strong id="toc-count">{{ tocCount }}</strong>
        </div>
        <nav id="toc-panel" class="toc-panel" :data-state="tocState" aria-live="polite">
          <p v-if="tocState !== 'ready'" class="toc-message">{{ tocMessage }}</p>
          <button
            v-for="heading in tocHeadings"
            :key="`${heading.page}-${heading.position}-${heading.title}`"
            class="toc-item"
            :class="{ active: activePage === heading.page }"
            type="button"
            :data-page="heading.page"
            :style="{ '--toc-level': Math.max(1, Math.min(Number(heading.level) || 1, 3)) }"
            :title="`Page ${heading.page}${tocCached ? ' · saved TOC' : ''}`"
            @click="navigateToPage(heading.page)"
          >{{ heading.title }}</button>
        </nav>
        <div class="toc-link-panel">
          <span class="toc-link-title">OUTLINE LINK</span>
          <label class="sr-only" for="link-target-select">Outline item</label>
          <select id="link-target-select" v-model="linkTargetId">
            <option :value="null" disabled>Select outline item</option>
            <option v-for="item in tocItems" :key="item.id" :value="item.id">{{ item.title }}</option>
          </select>
          <button class="toolbar-button subtle" type="button" :disabled="!linkTarget || !pdfDocument" @click="attachPdfPageToToc">Attach page {{ pdfPageNumber }}</button>
          <button class="toolbar-button subtle" type="button" :disabled="!tocHeadings.length" @click="importPdfHeadingsToToc">Import {{ tocHeadings.length }} heading{{ tocHeadings.length === 1 ? '' : 's' }}</button>
        </div>
      </aside>
      <div ref="pdfContentElement" class="pdf-content" @scroll.passive="handlePdfScroll">
        <input id="pdf-file-input" ref="pdfFileInput" class="sr-only" type="file" accept="application/pdf,.pdf" @change="handlePdfFile" />
        <div v-show="!pdfDocument" class="pdf-empty" id="pdf-empty">
          <span class="pdf-large-icon" aria-hidden="true">PDF</span>
          <h2>Read a local PDF</h2>
          <p>Use the system file picker to securely open a document from this computer.</p>
          <p v-if="pdfName !== 'No document selected'" class="pdf-resume">Last session: {{ pdfName }} · page {{ pdfPageNumber }} · {{ Math.round(pdfZoom * 100) }}%</p>
          <button v-if="pdfName !== 'No document selected'" class="toolbar-button subtle" id="resume-pdf" type="button" @click="pdfSourceUrl ? resumePdfSession() : openPdf()">Resume session</button>
          <button class="toolbar-button primary" id="browse-pdf" type="button" @click="openPdf">Browse files</button>
        </div>
        <div v-show="pdfDocument" class="pdf-rendered" aria-label="Selected PDF document">
          <div class="pdf-page-controls">
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber <= 1" @click="changePdfPage(-1)">Previous</button>
            <span>Page {{ pdfPageNumber }} of {{ pdfPageCount }}</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading || pdfPageNumber >= pdfPageCount" @click="changePdfPage(1)">Next</button>
            <span class="pdf-zoom-label">Zoom</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="pdfZoom = Math.max(0.6, pdfZoom - 0.1); renderAllPdfPages()">−</button>
            <span>{{ Math.round(pdfZoom * 100) }}%</span>
            <button class="toolbar-button subtle" type="button" :disabled="pdfLoading" @click="pdfZoom = Math.min(2.5, pdfZoom + 0.1); renderAllPdfPages()">+</button>
          </div>
          <div v-if="pdfRenderError" class="pdf-render-state error">{{ pdfRenderError }}</div>
          <div v-if="pdfLoading" class="pdf-render-state">Rendering all pages…</div>
          <div class="pdf-pages">
            <div v-for="pageNumber in pdfPageCount" :key="pageNumber" class="pdf-page">
              <canvas :ref="(element) => setPdfPageCanvas(element, pageNumber)" class="pdf-canvas" :aria-label="`Rendered PDF page ${pageNumber}`"></canvas>
            </div>
          </div>
        </div>
      </div>
    </section>

    <Teleport to="body">
      <div
        v-if="activeLightboxImage"
        class="lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        tabindex="-1"
        @click.self="closeLightbox"
        @keydown="handleLightboxKeydown"
      >
        <button class="lightbox-close" type="button" aria-label="Close preview" @click="closeLightbox">×</button>
        <button class="lightbox-nav previous" type="button" aria-label="Previous image" @click="changeLightbox(-1)">‹</button>
        <figure>
          <img :src="activeLightboxImage.dataUrl" :alt="activeLightboxImage.name" />
          <figcaption>{{ activeLightboxImage.relativePath }}</figcaption>
          <div class="lightbox-attach">
            <label class="sr-only" for="lightbox-link-target">Outline item</label>
            <select id="lightbox-link-target" v-model="linkTargetId">
              <option :value="null" disabled>Select outline item</option>
              <option v-for="item in tocItems" :key="item.id" :value="item.id">{{ item.title }}</option>
            </select>
            <button class="toolbar-button primary" type="button" :disabled="!linkTarget" @click="attachImageToToc(activeLightboxImage)">Attach to section</button>
          </div>
        </figure>
        <button class="lightbox-nav next" type="button" aria-label="Next image" @click="changeLightbox(1)">›</button>
      </div>
    </Teleport>
  </main>
</template>
