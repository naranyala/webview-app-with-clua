/*
 * Image Viewer session: folder selection, grouping, and the lightbox.
 *
 * Two sources feed the same state: the native folder picker (desktop) and a
 * webkitdirectory input (browser). Both end in setImageCollection(), which
 * normalizes, groups, and reports what was found.
 */
import { computed, nextTick, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { withFileTransfer } from './file-io.js';
import {
  groupImages,
  imagesFromFileList,
  makeThumbnail,
} from './image-viewer.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';
import { MAX_RECENT_PATHS } from './workspace.js';

export function createImageSession({
  boot = restoredWorkspace,
  /*
   * Resolved late on purpose: a test installs globalThis.document after this
   * module is imported, so capturing it as a default argument would freeze
   * "no document" for the whole session.
   */
  doc = null,
  native = getNativeBinding,
  call = runNativeCall,
  defer = nextTick,
} = {}) {
  const theDoc = () => doc ?? globalThis.document;
  /* --- selection state ------------------------------------------------------ */

  const imageDirectoryInput = ref(null);
  const imageDirectoryName = ref(boot.images.directoryName);
  /*
   * The absolute path of the open directory and the remembered list beside it.
   * Nothing is re-scanned on launch: an entry only re-opens when it is picked,
   * through openImageDirectoryAt.
   */
  const imageDirectoryPath = ref(boot.images.directoryPath);
  const imageRecentPaths = ref([...(boot.images.recentPaths ?? [])]);
  const imageGroups = ref([]);
  const imageFiles = ref([]);
  const selectedImageGroup = ref(boot.images.selectedGroup);
  const imageStatus = ref('Choose a parent directory to find images.');
  const imageStatusError = ref(false);
  const imageLoading = ref(false);
  /*
   * Whether the folders sidebar is showing. Above the narrow breakpoint it is a
   * real grid column and this is only ever true; below it, the sidebar overlays
   * the thumbnail grid so a phone gets the full width instead of a 145px column
   * beside it. The panel is never unmounted, so it keeps its scroll position --
   * the same reasoning as the map's `sidebar-closed`.
   */
  const imageSidebarOpen = ref(true);

  /* --- lightbox ------------------------------------------------------------- */

  const lightboxImage = ref(null);
  const lightboxIndex = ref(-1);

  /* Images of the selected group ("All Images" shows the flat list). */
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

  /* --- status --------------------------------------------------------------- */

  function setImageStatus(message, isError = false) {
    imageStatus.value = message;
    imageStatusError.value = isError;
  }

  /* --- collections ---------------------------------------------------------- */

  /*
   * Installs a new result set, keeps the selected group when it still exists,
   * and reports how many images were accepted.
   *
   * `thumbnail` is what the grid shows and `dataUrl` is kept as a fallback for a
   * host that predates the field, so a stale bundle still renders. The image's
   * own `path` is what the lightbox asks for when it needs full resolution --
   * the host no longer sends the original bytes for every image, which is the
   * point: a collection of 12 MP photos was ~120 MB of base64 held for the
   * whole session to fill 187x140 boxes.
   */
  function setImageCollection(images, directoryName) {
    const normalized = Array.isArray(images)
      ? images.filter((image) => image?.thumbnail || image?.dataUrl)
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

  /* --- remembered paths ------------------------------------------------------ */

  /*
   * Moves a directory to the front of the remembered list, dropping any earlier
   * entry for it and keeping the list at MAX_RECENT_PATHS. A path that arrives
   * empty (the browser directory input has no absolute path) is ignored, so the
   * history only holds directories a later scan can re-open.
   */
  function rememberImagePath(path) {
    const remembered = String(path ?? '').trim();
    if (!remembered) return;
    imageRecentPaths.value = [
      remembered,
      ...imageRecentPaths.value.filter((entry) => entry !== remembered),
    ].slice(0, MAX_RECENT_PATHS);
  }

  /* Drops one remembered directory, used when the host can no longer scan it. */
  function forgetImagePath(path) {
    const target = String(path ?? '').trim();
    if (!target) return;
    imageRecentPaths.value = imageRecentPaths.value.filter(
      (entry) => entry !== target,
    );
  }

  /*
   * Applies one host answer that is already a directory payload and remembers the
   * path it names. Shared by the chooser and the path binding so both remember
   * an entry identically.
   */
  function openImageDirectoryResult(result) {
    const images = Array.isArray(result.images) ? result.images : [];
    rememberImagePath(result.path);
    imageDirectoryPath.value = String(result.path || '');
    setImageCollection(images, result.name || 'Selected directory');
    if (images.length === 0)
      setImageStatus(
        'No supported images were found within the directory limits.',
        true,
      );
  }

  /* --- lightbox controls ---------------------------------------------------- */

  /*
   * The lightbox is the only view that shows an image larger than a thumbnail,
   * so it is the only one that needs the original bytes. The scan sends a
   * downscaled thumbnail per image; the full-resolution data URL is fetched here,
   * one image at a time, and dropped again on close.
   *
   * While the fetch is in flight the lightbox keeps showing the thumbnail, so
   * stepping through a folder never shows an empty frame. Outside the desktop
   * host there is no binding, so the thumbnail stays - the browser path has no
   * absolute path to ask about, and it already sent full-size data URLs.
   */
  const lightboxFullSizeUrl = ref('');
  const lightboxFullSizeLoading = ref(false);

  async function loadLightboxFullSize(image) {
    lightboxFullSizeUrl.value = '';
    lightboxFullSizeLoading.value = false;
    const path = String(image?.path ?? '');
    if (!path) return;
    const load = native('loadImageAt');
    if (!load) return;
    lightboxFullSizeLoading.value = true;
    const outcome = await withFileTransfer(() => call(() => load(path)), {
      report: () => {},
      messages: {
        error: 'The full-size image could not be loaded.',
      },
    });
    lightboxFullSizeLoading.value = false;
    if (outcome.status === 'done') {
      const dataUrl = String(outcome.result?.dataUrl || '');
      if (dataUrl) lightboxFullSizeUrl.value = dataUrl;
    }
  }

  function openLightbox(image) {
    lightboxIndex.value = visibleImages.value.indexOf(image);
    if (lightboxIndex.value >= 0) {
      lightboxImage.value = image;
      loadLightboxFullSize(image);
      defer(() => theDoc().querySelector('.lightbox')?.focus());
    }
  }

  function changeLightbox(offset) {
    if (visibleImages.value.length === 0) return;
    lightboxIndex.value =
      (lightboxIndex.value + offset + visibleImages.value.length) %
      visibleImages.value.length;
    lightboxImage.value = visibleImages.value[lightboxIndex.value];
    // loadLightboxFullSize clears the previous URL synchronously, before its own
    // first await, so stepping never holds two full-resolution images at once.
    // Holding the arrow key therefore cannot accumulate them.
    loadLightboxFullSize(lightboxImage.value);
  }

  function closeLightbox() {
    lightboxImage.value = null;
    lightboxIndex.value = -1;
    lightboxFullSizeUrl.value = '';
    lightboxFullSizeLoading.value = false;
  }

  function handleLightboxKeydown(event) {
    if (!lightboxImage.value) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') changeLightbox(-1);
    if (event.key === 'ArrowRight') changeLightbox(1);
  }

  /* --- sources -------------------------------------------------------------- */

  /* Browser fallback: reads the chosen directory from the file list input. */
  async function loadBrowserImageDirectory(event) {
    const files = event.target.files;
    if (!files?.length) return;
    imageLoading.value = true;
    setImageStatus('Reading images…');
    try {
      const result = await imagesFromFileList(files, {
        /*
         * The browser path has no native scan to downscale for it, so it uses
         * createImageBitmap and a canvas. Both are read through the session's
         * injected document rather than the global, so this stays testable in
         * plain node and does not freeze "no canvas" for a consumer that
         * installs one later.
         */
        thumbnail: makeThumbnail(
          globalThis.createImageBitmap?.bind(globalThis),
          theDoc(),
        ),
      });
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
        setImageStatus(
          'No supported images were found in this directory.',
          true,
        );
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

  /*
   * Native folder picker when the host provides it, browser directory input
   * otherwise. Empty results are reported rather than shown as a blank grid.
   */
  async function openImageDirectory() {
    const openDirectory = native('openImageDirectory');
    if (!openDirectory) {
      imageDirectoryInput.value?.click();
      return;
    }
    imageLoading.value = true;
    const outcome = await withFileTransfer(() => call(openDirectory), {
      report: setImageStatus,
      messages: {
        pending: 'Waiting for the system directory picker…',
        canceled: 'Directory selection was cancelled.',
        error: 'Could not open the image directory.',
      },
    });
    try {
      if (outcome.status !== 'done') return;
      openImageDirectoryResult(outcome.result);
    } finally {
      imageLoading.value = false;
    }
  }

  /*
   * Re-scans a remembered directory without showing the chooser. A directory
   * that has been moved or deleted is dropped from the list, so the history
   * heals itself instead of accumulating entries that cannot be opened.
   */
  async function openImageDirectoryAt(path) {
    const target = String(path ?? '').trim();
    if (!target) return;
    const openAt = native('openImageDirectoryAt');
    if (!openAt) {
      setImageStatus(
        'Opening a remembered directory is available in the desktop app.',
      );
      return;
    }
    imageLoading.value = true;
    const outcome = await withFileTransfer(() => call(() => openAt(target)), {
      report: setImageStatus,
      messages: {
        pending: `Reading ${target}…`,
        error: 'Could not open the remembered directory.',
      },
    });
    try {
      if (outcome.status === 'canceled') return;
      if (outcome.status !== 'done') {
        forgetImagePath(target);
        return;
      }
      openImageDirectoryResult(outcome.result);
    } finally {
      imageLoading.value = false;
    }
  }

  /* Menu badge: folder and count of the current selection. */

  const imagesBadge = computed(() => {
    if (imageFiles.value.length > 0) {
      const count = `${imageFiles.value.length} image${imageFiles.value.length === 1 ? '' : 's'}`;
      return `${imageDirectoryName.value || 'Folder'} · ${count}`;
    }
    if (imageRecentPaths.value.length > 0) {
      return `${imageRecentPaths.value.length} remembered director${imageRecentPaths.value.length === 1 ? 'y' : 'ies'}`;
    }
    return 'Browse images grouped by folder';
  });

  /* --- sidebar -------------------------------------------------------------- */

  function toggleImageSidebar() {
    imageSidebarOpen.value = !imageSidebarOpen.value;
  }

  return {
    imageDirectoryInput,
    imageDirectoryName,
    imageDirectoryPath,
    imageRecentPaths,
    imageGroups,
    imageFiles,
    selectedImageGroup,
    imageSidebarOpen,
    imageStatus,
    imageStatusError,
    imageLoading,
    lightboxImage,
    lightboxIndex,
    lightboxFullSizeUrl,
    lightboxFullSizeLoading,
    visibleImages,
    activeLightboxImage,
    imagesBadge,
    setImageStatus,
    setImageCollection,
    rememberImagePath,
    forgetImagePath,
    openLightbox,
    changeLightbox,
    closeLightbox,
    handleLightboxKeydown,
    loadBrowserImageDirectory,
    openImageDirectory,
    openImageDirectoryAt,
    toggleImageSidebar,
  };
}

/*
 * The app's single Image Viewer session. Every export below is a binding of
 * this default instance, so App.vue and toc-outline.js keep importing plain
 * refs while tests can build isolated sessions with createImageSession().
 */
const session = createImageSession();

export const imageDirectoryInput = session.imageDirectoryInput;
export const imageDirectoryName = session.imageDirectoryName;
export const imageDirectoryPath = session.imageDirectoryPath;
export const imageRecentPaths = session.imageRecentPaths;
export const imageGroups = session.imageGroups;
export const imageFiles = session.imageFiles;
export const selectedImageGroup = session.selectedImageGroup;
export const imageSidebarOpen = session.imageSidebarOpen;
export const imageStatus = session.imageStatus;
export const imageStatusError = session.imageStatusError;
export const imageLoading = session.imageLoading;
export const lightboxImage = session.lightboxImage;
export const lightboxIndex = session.lightboxIndex;
export const lightboxFullSizeUrl = session.lightboxFullSizeUrl;
export const lightboxFullSizeLoading = session.lightboxFullSizeLoading;
export const visibleImages = session.visibleImages;
export const activeLightboxImage = session.activeLightboxImage;
export const imagesBadge = session.imagesBadge;
export const setImageStatus = session.setImageStatus;
export const setImageCollection = session.setImageCollection;
export const rememberImagePath = session.rememberImagePath;
export const forgetImagePath = session.forgetImagePath;
export const openLightbox = session.openLightbox;
export const changeLightbox = session.changeLightbox;
export const closeLightbox = session.closeLightbox;
export const handleLightboxKeydown = session.handleLightboxKeydown;
export const loadBrowserImageDirectory = session.loadBrowserImageDirectory;
export const openImageDirectory = session.openImageDirectory;
export const openImageDirectoryAt = session.openImageDirectoryAt;
export const toggleImageSidebar = session.toggleImageSidebar;
