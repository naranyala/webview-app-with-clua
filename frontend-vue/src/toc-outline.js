/*
 * TOC Manager session: the outline itself and the actions that bind it to the
 * other tools (drafts in the editor, pages in the reader, files in the viewer).
 *
 * The outline is the spine of the workspace, so this module reaches into the
 * sibling sessions to open a linked page or image. It never persists on its
 * own: App.vue injects the workspace writer, which keeps the dependency
 * pointing one way (this module -> App) instead of forming a cycle.
 */
import { computed, nextTick, ref } from 'vue';

import { markUserInteracted, selectView } from './app-shell.js';
import { restoredWorkspace } from './boot-state.js';
import { editorContent, editorInput, updateCursor } from './editor-session.js';
import {
  imageFiles,
  openLightbox,
  selectedImageGroup,
  setImageStatus,
} from './image-session.js';
import {
  navigateToPage,
  pdfDocument,
  pdfName,
  pdfPageNumber,
  resumePdfSession,
  setPdfStatus,
  tocHeadings,
} from './pdf-session.js';
import { clampLevel, createTocItem } from './workspace.js';

/* --- outline state -------------------------------------------------------- */

export const tocItems = ref(restoredWorkspace.tocItems);
export const activeTocId = ref(
  restoredWorkspace.tocItems.some(
    (item) => item.id === restoredWorkspace.activeTocId,
  )
    ? restoredWorkspace.activeTocId
    : null,
);
export const linkTargetId = ref(
  activeTocId.value || restoredWorkspace.tocItems[0]?.id || null,
);
export const tocDraftTitle = ref('');
export const tocDraftLevel = ref(1);
export const tocStatus = ref(
  'Declare an outline item, then select it to start writing.',
);
export const tocStatusError = ref(false);

/* --- persistence hook (installed by App.vue) ------------------------------ */

let persistNow = () => true;

export function configureTocOutline(options) {
  persistNow = options.persistNow;
}

/* --- derived outline state ------------------------------------------------ */

export const activeTocItem = computed(
  () => tocItems.value.find((item) => item.id === activeTocId.value) || null,
);

export const tocItemLabel = computed(
  () =>
    `${tocItems.value.length} item${tocItems.value.length === 1 ? '' : 's'} declared`,
);

export const activeTocIndex = computed(() =>
  tocItems.value.findIndex((item) => item.id === activeTocId.value),
);

/* Item the "attach" actions write to: the explicit target, else the active one. */
export const linkTarget = computed(
  () =>
    tocItems.value.find((item) => item.id === linkTargetId.value) ||
    activeTocItem.value ||
    null,
);

export const previousTocItem = computed(() =>
  activeTocIndex.value > 0 ? tocItems.value[activeTocIndex.value - 1] : null,
);

export const nextTocItem = computed(() =>
  activeTocIndex.value >= 0 && activeTocIndex.value < tocItems.value.length - 1
    ? tocItems.value[activeTocIndex.value + 1]
    : null,
);

/* --- status --------------------------------------------------------------- */

export function setTocStatus(message, isError = false) {
  tocStatus.value = message;
  tocStatusError.value = isError;
}

/* Writes the outline through the injected workspace writer. */
export function saveTocItems() {
  markUserInteracted();
  const saved = persistNow();
  tocStatusError.value = !saved;
  if (!saved) {
    tocStatus.value = 'The workspace could not be saved in this browser.';
  }
  return saved;
}

/* --- editor binding ------------------------------------------------------- */

/* Copies the editor buffer into the active item without switching views. */
export function syncTocDraft() {
  const item = activeTocItem.value;
  if (!item || item.content === editorContent.value) return;
  markUserInteracted();
  item.content = editorContent.value;
  item.updatedAt = Date.now();
  persistNow();
}

/* --- outline CRUD --------------------------------------------------------- */

export function addTocItem() {
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

export function removeTocItem(item) {
  const index = tocItems.value.findIndex((entry) => entry.id === item.id);
  if (index < 0) return;
  tocItems.value.splice(index, 1);
  if (activeTocId.value === item.id) activeTocId.value = null;
  if (saveTocItems()) setTocStatus(`“${item.title}” removed from the outline.`);
}

export function selectTocItem(item) {
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

/* --- links to the other tools --------------------------------------------- */

/* Stores the current reader page on the selected outline item. */
export function attachPdfPageToToc() {
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

/*
 * Turns the extracted headings into outline items, skipping titles that are
 * already declared for the same page.
 */
export function importPdfHeadingsToToc() {
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
    const duplicate = tocItems.value.some(
      (item) => item.title === title && (item.links.pdfPage ?? null) === page,
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

/* Opens the reader on the page linked to an outline item. */
export async function openLinkedPdfPage(item) {
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

/* Stores an image path on the selected outline item. */
export function attachImageToToc(image) {
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

/* Switches to the viewer and opens the first attached image in the lightbox. */
export function openLinkedImages(item) {
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
    `${paths.length} attached image${paths.length === 1 ? '' : 's'} ${
      paths.length === 1 ? 'needs' : 'need'
    } the original folder to be selected again.`,
    true,
  );
}
