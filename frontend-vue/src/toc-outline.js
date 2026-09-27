/*
 * TOC Manager session: the outline itself and the actions that bind it to the
 * other tools (drafts in the editor, pages in the reader, files in the viewer,
 * a place on the map).
 *
 * The outline is the spine of the workspace, so this module reaches into the
 * sibling sessions to open a linked page, image, or location. It never persists
 * on its own: App.vue injects the workspace writer, which keeps the dependency
 * pointing one way (this module -> App) instead of forming a cycle.
 *
 * The sibling sessions arrive as factory arguments (defaulting to the app's own
 * instances), so a test can build an outline with stub collaborators instead of
 * driving the real ones.
 */
import { computed, nextTick, ref } from 'vue';

import * as appShell from './app-shell.js';
import { restoredWorkspace } from './boot-state.js';
import * as editorSession from './editor-session.js';
import {
  readFileAsText,
  suggestFileName,
  withTextFileRead,
  withTextFileWrite,
} from './file-io.js';
import { normalizeLocation } from './geo.js';
import * as imageSession from './image-session.js';
import * as mapSession from './map-explorer.js';
import * as pdfSession from './pdf-session.js';
import { clampLevel, createTocItem, MAX_IMAGES_PER_ITEM } from './workspace.js';

/*
 * The TOC Manager session: the outline spine, its links to the other tools, the
 * draft binding, and the JSON/text transfers.
 *
 * Like the other sessions this is a factory, so a test can hold two outlines at
 * once. It also takes the collaborators it used to import directly — the editor
 * session, the PDF, image, and map sessions, the shell, and the boot snapshot —
 * which is what makes an isolated outline possible without module mocking.
 * App.vue and the tests keep using the default instance exported below.
 */
export function createTocOutline({
  boot = restoredWorkspace,
  editor = editorSession,
  shell = appShell,
  pdf = pdfSession,
  images = imageSession,
  map = mapSession,
  doc = null,
  defer = nextTick,
  persist: persistNow = () => true,
  transfer = { read: withTextFileRead, write: withTextFileWrite },
} = {}) {
  const theDoc = () => doc ?? globalThis.document;
  const {
    editorContent,
    editorInput,
    setEditorNotice,
    clearEditorNotice,
    updateCursor,
  } = editor;
  const { markUserInteracted, selectView } = shell;
  const {
    pdfDocument,
    pdfName,
    pdfPageNumber,
    pdfPath,
    pdfStatus,
    pdfStatusError,
    setPdfStatus,
    navigateToPage,
    openPdfAt,
    tocHeadings,
    setTocMessage,
  } = pdf;
  const {
    activeLightboxImage,
    imageFiles,
    selectedImageGroup,
    imageGroupFromRelativePath,
    setImageCollection,
    openLightbox,
    setImageStatus,
  } = images;
  const { mapPin, showMapLocation, flyToLocation, setMapStatus } = map;
  const { read: readTransfer, write: writeTransfer } = transfer;

  /* --- outline state -------------------------------------------------------- */

  const tocItems = ref(boot.tocItems);
  const activeTocId = ref(
    boot.tocItems.some((item) => item.id === boot.activeTocId)
      ? boot.activeTocId
      : null,
  );
  const linkTargetId = ref(activeTocId.value || boot.tocItems[0]?.id || null);
  const tocDraftTitle = ref('');
  const tocDraftLevel = ref(1);
  const tocStatus = ref(
    'Declare an outline item, then select it to start writing.',
  );
  const tocStatusError = ref(false);
  /* Filter box in the manager (shown once the outline is long). */
  const tocFilterQuery = ref('');
  /* Inline row editing: exactly one item can be open at a time. */
  const editingTocId = ref(null);
  const tocEditTitle = ref('');
  const tocEditLevel = ref(1);
  /*
   * Undo record for the last removal: the item, its position, and whether it
   * was the active one. Cleared by the next outline mutation, never by a timer.
   */
  const lastRemoved = ref(null);

  /* --- persistence hook (installed by App.vue) ------------------------------ */

  function configureTocOutline(options) {
    persistNow = options.persistNow;
  }

  /* --- derived outline state ------------------------------------------------ */

  const activeTocItem = computed(
    () => tocItems.value.find((item) => item.id === activeTocId.value) || null,
  );

  const tocItemLabel = computed(
    () =>
      `${tocItems.value.length} item${tocItems.value.length === 1 ? '' : 's'} declared`,
  );

  const activeTocIndex = computed(() =>
    tocItems.value.findIndex((item) => item.id === activeTocId.value),
  );

  /* Item the "attach" actions write to: the explicit target, else the active one. */
  const linkTarget = computed(
    () =>
      tocItems.value.find((item) => item.id === linkTargetId.value) ||
      activeTocItem.value ||
      null,
  );

  const previousTocItem = computed(() =>
    activeTocIndex.value > 0 ? tocItems.value[activeTocIndex.value - 1] : null,
  );

  const nextTocItem = computed(() =>
    activeTocIndex.value >= 0 &&
    activeTocIndex.value < tocItems.value.length - 1
      ? tocItems.value[activeTocIndex.value + 1]
      : null,
  );

  /* The filter input only appears when there are enough items to need it. */
  const showTocFilter = computed(() => tocItems.value.length >= 8);

  /*
   * Case-insensitive title filter. An empty (or whitespace-only) query returns
   * the outline itself, so the indices still address the real order.
   */
  const filteredTocItems = computed(() => {
    const query = tocFilterQuery.value.trim().toLowerCase();
    if (!query) return tocItems.value;
    return tocItems.value.filter((item) =>
      item.title.toLowerCase().includes(query),
    );
  });

  /* --- status --------------------------------------------------------------- */

  function setTocStatus(message, isError = false) {
    tocStatus.value = message;
    tocStatusError.value = isError;
  }

  /*
   * Writes the outline through the injected workspace writer.
   *
   * persistNow reports the synchronous local write, because that is the only
   * part a click handler can act on. A durable-store failure arrives later and
   * is routed to the TOC status by the composition layer's failure callback, so
   * this must not clear the error state the callback may have set.
   */
  function saveTocItems() {
    markUserInteracted();
    const saved = persistNow();
    if (saved === false) {
      tocStatusError.value = true;
      tocStatus.value = 'The workspace could not be saved in this browser.';
    }
    return saved;
  }

  /* --- editor binding ------------------------------------------------------- */

  /* Copies the editor buffer into the active item without switching views. */
  function syncTocDraft() {
    const item = activeTocItem.value;
    if (!item || item.content === editorContent.value) return;
    markUserInteracted();
    item.content = editorContent.value;
    item.updatedAt = Date.now();
    persistNow();
  }

  /* --- outline CRUD --------------------------------------------------------- */

  /* Any structural mutation invalidates a pending undo. */
  function clearPendingUndo() {
    lastRemoved.value = null;
  }

  function addTocItem() {
    clearPendingUndo();
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
    defer(() => theDoc().getElementById('toc-title-input')?.focus());
  }

  function removeTocItem(item) {
    const index = tocItems.value.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    lastRemoved.value = {
      item,
      index,
      wasActive: activeTocId.value === item.id,
    };
    tocItems.value.splice(index, 1);
    if (activeTocId.value === item.id) activeTocId.value = null;
    if (saveTocItems())
      setTocStatus(`“${item.title}” removed from the outline.`);
  }

  /* Restores the last removal at its old position with its selection state. */
  function undoTocRemoval() {
    const record = lastRemoved.value;
    if (!record) return;
    lastRemoved.value = null;
    tocItems.value.splice(
      Math.min(record.index, tocItems.value.length),
      0,
      record.item,
    );
    if (record.wasActive) activeTocId.value = record.item.id;
    if (saveTocItems()) {
      setTocStatus(`“${record.item.title}” restored to the outline.`);
    }
  }

  /* --- inline editing ------------------------------------------------------- */

  function startTocEdit(item) {
    if (!item) return;
    clearPendingUndo();
    editingTocId.value = item.id;
    tocEditTitle.value = item.title;
    tocEditLevel.value = item.level;
    defer(() => theDoc().getElementById('toc-edit-input')?.focus());
  }

  function cancelTocEdit() {
    editingTocId.value = null;
    tocEditTitle.value = '';
    tocEditLevel.value = 1;
  }

  /*
   * Applies the edited title and level in place, so the draft, links, id, and
   * position survive a rename. An empty title is rejected like declaring is.
   */
  function saveTocEdit(item) {
    if (!item || editingTocId.value !== item.id) return;
    const title = tocEditTitle.value.trim();
    if (!title) {
      setTocStatus('Enter a heading title before saving.', true);
      return;
    }
    item.title = title.slice(0, 120);
    item.level = clampLevel(tocEditLevel.value);
    item.updatedAt = Date.now();
    if (saveTocItems()) setTocStatus(`“${item.title}” updated.`);
    cancelTocEdit();
  }

  /* --- reordering ----------------------------------------------------------- */

  /*
   * Swaps an item with its neighbour. Bounds and an active filter are no-ops
   * (the template also disables the buttons) so order stays unambiguous.
   */
  function moveTocItem(item, delta) {
    const index = tocItems.value.findIndex((entry) => entry.id === item.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= tocItems.value.length) return;
    if (tocFilterQuery.value.trim()) return;
    clearPendingUndo();
    const [moved] = tocItems.value.splice(index, 1);
    tocItems.value.splice(target, 0, moved);
    if (saveTocItems()) {
      setTocStatus(`Moved “${moved.title}” ${delta < 0 ? 'up' : 'down'}.`);
    }
  }

  function selectTocItem(item) {
    syncTocDraft();
    activeTocId.value = item.id;
    editorContent.value = item.content ?? '';
    setEditorNotice('');
    selectView('editor');
    defer(() => {
      updateCursor();
      editorInput.value?.focus();
    });
    setTocStatus(`Writing “${item.title}”.`);
  }

  /* --- file transfer (import/export) ---------------------------------------- */

  /* Template refs for the hidden fallback inputs (native picker is preferred). */
  const tocImportInput = ref(null);
  const editorImportInput = ref(null);

  /* Versioned envelope for the outline export; ids are rebuilt on import. */
  function exportTocJson() {
    return JSON.stringify(
      {
        format: 'metrics-toc',
        version: 1,
        exportedAt: new Date().toISOString(),
        items: tocItems.value.map((item) => ({
          title: item.title,
          level: item.level,
          content: item.content,
          links: item.links,
          updatedAt: item.updatedAt,
        })),
      },
      null,
      2,
    );
  }

  /*
   * Parses an outline export and appends its sections after the existing ones
   * (never destructive). Every imported item gets a fresh id through
   * createTocItem(); malformed entries are skipped, and any parse or shape
   * failure reports through the TOC status line instead of throwing.
   */
  function importTocJson(text, sourceName = 'the chosen file') {
    let parsed;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      setTocStatus('That file is not valid JSON.', true);
      return false;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      setTocStatus('That file is not an outline export.', true);
      return false;
    }
    if (parsed.format !== 'metrics-toc') {
      setTocStatus('That file is not an outline export.', true);
      return false;
    }
    if (Number(parsed.version) !== 1) {
      setTocStatus('That outline export uses an unsupported version.', true);
      return false;
    }
    const entries = Array.isArray(parsed.items) ? parsed.items : [];
    const imported = [];
    for (const entry of entries) {
      const item = createTocItem({
        title: entry?.title,
        level: entry?.level,
        content: entry?.content,
        links: entry?.links,
        updatedAt: entry?.updatedAt,
      });
      if (item) imported.push(item);
    }
    if (imported.length === 0) {
      setTocStatus('That outline export has no sections.', true);
      return false;
    }
    clearPendingUndo();
    tocItems.value.push(...imported);
    if (saveTocItems()) {
      const suffix =
        imported.length === entries.length
          ? ''
          : ` (${entries.length - imported.length} skipped)`;
      setTocStatus(
        `Imported ${imported.length} section${imported.length === 1 ? '' : 's'} from ${sourceName}${suffix}.`,
      );
    }
    return true;
  }

  /* Writes the whole outline to a JSON file via the system save dialog. */
  async function exportTocToFile() {
    if (tocItems.value.length === 0) {
      setTocStatus('Declare at least one section before exporting.', true);
      return;
    }
    await writeTransfer('outline.json', exportTocJson(), {
      report: setTocStatus,
      messages: {
        pending: 'Waiting for the system save dialog…',
        canceled: 'Export was cancelled.',
        error: 'The outline could not be saved.',
      },
      handle: (saved) =>
        setTocStatus(
          saved.path
            ? `Outline saved to ${saved.path}.`
            : `Outline downloaded as ${saved.name}.`,
        ),
    });
  }

  /*
   * Reads an outline export: system open picker when the host provides it,
   * otherwise the hidden input (handleTocImportFile continues that path).
   */
  async function importTocFromFile() {
    const outcome = await readTransfer({
      // Without the host the hidden input takes over; handleTocImportFile
      // finishes the job in the browser.
      pick: async () => {
        tocImportInput.value?.click();
        return null;
      },
      report: setTocStatus,
      messages: {
        canceled: 'Import was cancelled.',
        error: 'The outline could not be read.',
      },
      handle: (picked) => {
        setTocStatus('Importing the outline…');
        return importTocJson(picked.content, picked.name || 'the chosen file');
      },
    });
    return outcome;
  }

  /* Continues an import started through the hidden fallback input. */
  function handleTocImportFile(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) {
      setTocStatus('Import was cancelled.');
      return;
    }
    setTocStatus('Importing the outline…');
    readFileAsText(file).then(
      (text) => importTocJson(text, file.name),
      () => setTocStatus('The chosen file could not be read.', true),
    );
  }

  /* Writes the active section's draft to a text file. */
  async function exportActiveDraftToFile() {
    const item = activeTocItem.value;
    if (!item) {
      setEditorNotice('Pick a section before exporting.', true);
      return;
    }
    const suggested = suggestFileName(item.title, 'txt', 'section.txt');
    await writeTransfer(suggested, editorContent.value, {
      report: setEditorNotice,
      messages: {
        pending: 'Waiting for the system save dialog…',
        canceled: 'Export was cancelled.',
        error: 'The draft could not be saved.',
      },
      handle: (saved) =>
        setEditorNotice(
          saved.path
            ? `Saved to ${saved.path}.`
            : `Downloaded as ${saved.name}.`,
        ),
    });
  }

  /*
   * Replaces the active draft with the contents of a text file: system open
   * picker when the host provides it, otherwise the hidden fallback input.
   * The replacement flows through syncTocDraft() so the outline item, the
   * word count, and the workspace stay in step.
   */
  async function importActiveDraftFromFile() {
    const item = activeTocItem.value;
    if (!item) {
      setEditorNotice('Pick a section before importing.', true);
      return;
    }
    return readTransfer({
      // Without the host the hidden input takes over; handleEditorImportFile
      // finishes the job in the browser.
      pick: async () => {
        editorImportInput.value?.click();
        return null;
      },
      report: setEditorNotice,
      messages: {
        canceled: 'Import was cancelled.',
        error: 'The file could not be read.',
      },
      handle: (picked) =>
        applyDraftImport(picked.content, picked.name || 'the chosen file'),
    });
  }

  /* Continues a draft import started through the hidden fallback input. */

  function handleEditorImportFile(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (input) input.value = '';
    if (!file) {
      setEditorNotice('Import was cancelled.');
      return;
    }
    if (!activeTocItem.value) {
      setEditorNotice('Pick a section before importing.', true);
      return;
    }
    readFileAsText(file).then(
      (text) => applyDraftImport(text, file.name),
      () => setEditorNotice('The chosen file could not be read.', true),
    );
  }

  /* Swaps the buffer for the imported text and flushes it into the item. */
  function applyDraftImport(text, sourceName) {
    editorContent.value = String(text);
    syncTocDraft();
    defer(() => updateCursor());
    setEditorNotice(`Draft replaced by “${sourceName}”.`);
  }

  /* --- links to the other tools --------------------------------------------- */

  /* Stores the current reader page on the selected outline item. */
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
      setPdfStatus(
        `Page ${pdfPageNumber.value} attached to “${target.title}”.`,
      );
    }
  }

  /*
   * Turns the extracted headings into outline items, skipping titles that are
   * already declared for the same page.
   */
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

  /*
   * Opens the reader on the page linked to an outline item. The viewer no longer
   * restores a document by itself, so a jump with nothing open re-opens the
   * document the link came from - an explicit action, not a background restore.
   */
  async function openLinkedPdfPage(item) {
    const page = item?.links?.pdfPage;
    if (!page) return;
    selectView('pdf');
    if (!pdfDocument.value) {
      if (pdfPath.value) await openPdfAt(pdfPath.value);
    }
    if (pdfDocument.value) {
      navigateToPage(page);
    } else {
      setPdfStatus(`Open the source document to jump to page ${page}.`, true);
    }
  }

  /* Stores an image path on the selected outline item. */
  /*
   * The same cap the workspace schema enforces when it reads a record
   * (workspace.js: MAX_IMAGES_PER_ITEM). Without it a 65th attachment was
   * written, exported, and then dropped on the next load with no message.
   */
  const maxImagesPerItem = MAX_IMAGES_PER_ITEM;

  function attachImageToToc(image) {
    const target = linkTarget.value;
    const path = image?.relativePath;
    if (!target || !path) {
      setImageStatus('Select an outline item to attach this image to.', true);
      return;
    }
    if (!target.links.images.includes(path)) {
      if (target.links.images.length >= maxImagesPerItem) {
        setImageStatus(
          `“${target.title}” already links ${maxImagesPerItem} images. Remove one before attaching another.`,
          true,
        );
        return;
      }
      target.links.images.push(path);
    }
    target.updatedAt = Date.now();
    if (saveTocItems()) {
      setImageStatus(`“${image.name}” attached to “${target.title}”.`);
    }
  }

  /* Switches to the viewer and opens the first attached image in the lightbox. */
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
      `${paths.length} attached image${paths.length === 1 ? '' : 's'} ${
        paths.length === 1 ? 'needs' : 'need'
      } the original folder to be selected again.`,
      true,
    );
  }

  /* --- links to the map ------------------------------------------------------ */

  /*
   * Stores the explorer's current pin on the selected outline item.
   *
   * Unlike the image link, a location is self-contained: the record holds the
   * coordinates themselves, so it resolves on any later launch without the
   * original directory being re-selected. The label is copied alongside so a
   * future reverse-geocoded name survives; nothing in the app sets one yet.
   */
  function attachLocationToToc() {
    const target = linkTarget.value;
    if (!target) {
      setMapStatus('Select an outline item to attach this location to.', true);
      return;
    }
    const pin = mapPin.value;
    if (!pin) {
      setMapStatus('Click the map to drop a pin before attaching it.', true);
      return;
    }
    target.links.location = { ...pin };
    target.updatedAt = Date.now();
    if (saveTocItems()) {
      setMapStatus(`Location attached to “${target.title}”.`);
    }
  }

  /*
   * Copies a saved place onto the selected outline item as its location link.
   *
   * This is the join between the two models: a place is somewhere the reader has
   * been, a link is somewhere a section is about. The label rides along so the
   * outline row and the map status can name the place rather than printing bare
   * coordinates, and attaching replaces any previous location rather than adding
   * a second one - a section is written about one place at a time.
   */
  function attachPlaceToToc(place) {
    const target = linkTarget.value;
    if (!target) {
      setMapStatus('Select an outline item to attach this place to.', true);
      return false;
    }
    if (!place) {
      setMapStatus('Choose a saved place to attach.', true);
      return false;
    }
    const location = normalizeLocation(place);
    if (!location) {
      setMapStatus('That place is not a usable coordinate.', true);
      return false;
    }
    target.links.location = {
      ...location,
      label: String(place.label ?? location.label ?? '')
        .trim()
        .slice(0, 120),
    };
    target.updatedAt = Date.now();
    if (saveTocItems()) {
      setMapStatus(
        `“${target.links.location.label}” attached to “${target.title}”.`,
      );
    }
    return true;
  }

  /* Switches to the explorer and centres it on the item's saved place. */
  function openLinkedLocation(item) {
    const location = item?.links?.location;
    if (!location) return;
    selectView('map');
    /* Travelled, not teleported: the reader followed a link and should see
       where it took them. */
    if (!flyToLocation(location)) {
      setMapStatus('The saved location could not be read.', true);
    }
  }

  return {
    activeTocId,
    activeTocIndex,
    activeTocItem,
    addTocItem,
    attachImageToToc,
    attachLocationToToc,
    attachPdfPageToToc,
    attachPlaceToToc,
    cancelTocEdit,
    configureTocOutline,
    createTocOutline,
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
  };
}

/*
 * The app's single outline. configureTocOutline() injects the workspace
 * writer, which is the only inversion of control the session layer needs.
 */
const outline = createTocOutline();
export const activeTocId = outline.activeTocId;
export const activeTocIndex = outline.activeTocIndex;
export const activeTocItem = outline.activeTocItem;
export const addTocItem = outline.addTocItem;
export const attachImageToToc = outline.attachImageToToc;
export const attachLocationToToc = outline.attachLocationToToc;
export const attachPdfPageToToc = outline.attachPdfPageToToc;
export const attachPlaceToToc = outline.attachPlaceToToc;
export const cancelTocEdit = outline.cancelTocEdit;
export const configureTocOutline = outline.configureTocOutline;
export const editingTocId = outline.editingTocId;
export const editorImportInput = outline.editorImportInput;
export const exportActiveDraftToFile = outline.exportActiveDraftToFile;
export const exportTocJson = outline.exportTocJson;
export const exportTocToFile = outline.exportTocToFile;
export const filteredTocItems = outline.filteredTocItems;
export const handleEditorImportFile = outline.handleEditorImportFile;
export const handleTocImportFile = outline.handleTocImportFile;
export const importActiveDraftFromFile = outline.importActiveDraftFromFile;
export const importPdfHeadingsToToc = outline.importPdfHeadingsToToc;
export const importTocFromFile = outline.importTocFromFile;
export const importTocJson = outline.importTocJson;
export const lastRemoved = outline.lastRemoved;
export const linkTarget = outline.linkTarget;
export const linkTargetId = outline.linkTargetId;
export const moveTocItem = outline.moveTocItem;
export const nextTocItem = outline.nextTocItem;
export const openLinkedImages = outline.openLinkedImages;
export const openLinkedLocation = outline.openLinkedLocation;
export const openLinkedPdfPage = outline.openLinkedPdfPage;
export const previousTocItem = outline.previousTocItem;
export const removeTocItem = outline.removeTocItem;
export const saveTocEdit = outline.saveTocEdit;
export const saveTocItems = outline.saveTocItems;
export const selectTocItem = outline.selectTocItem;
export const setTocStatus = outline.setTocStatus;
export const showTocFilter = outline.showTocFilter;
export const startTocEdit = outline.startTocEdit;
export const syncTocDraft = outline.syncTocDraft;
export const tocDraftLevel = outline.tocDraftLevel;
export const tocDraftTitle = outline.tocDraftTitle;
export const tocEditLevel = outline.tocEditLevel;
export const tocEditTitle = outline.tocEditTitle;
export const tocFilterQuery = outline.tocFilterQuery;
export const tocImportInput = outline.tocImportInput;
export const tocItemLabel = outline.tocItemLabel;
export const tocItems = outline.tocItems;
export const tocStatus = outline.tocStatus;
export const tocStatusError = outline.tocStatusError;
export const undoTocRemoval = outline.undoTocRemoval;
