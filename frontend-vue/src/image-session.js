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
import { groupImages, imagesFromFileList } from './image-viewer.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';

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
  const imageGroups = ref([]);
  const imageFiles = ref([]);
  const selectedImageGroup = ref(boot.images.selectedGroup);
  const imageStatus = ref('Choose a parent directory to find images.');
  const imageStatusError = ref(false);
  const imageLoading = ref(false);

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
   */
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

  /* --- lightbox controls ---------------------------------------------------- */

  function openLightbox(image) {
    lightboxIndex.value = visibleImages.value.indexOf(image);
    if (lightboxIndex.value >= 0) {
      lightboxImage.value = image;
      defer(() => theDoc().querySelector('.lightbox')?.focus());
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

  /* --- sources -------------------------------------------------------------- */

  /* Browser fallback: reads the chosen directory from the file list input. */
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
      const result = outcome.result;
      const images = Array.isArray(result.images) ? result.images : [];
      setImageCollection(images, result.name || 'Selected directory');
      if (images.length === 0)
        setImageStatus(
          'No supported images were found within the directory limits.',
          true,
        );
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
    if (imageDirectoryName.value) {
      return `${imageDirectoryName.value} · re-select to reload`;
    }
    return 'Browse images grouped by folder';
  });

  return {
    imageDirectoryInput,
    imageDirectoryName,
    imageGroups,
    imageFiles,
    selectedImageGroup,
    imageStatus,
    imageStatusError,
    imageLoading,
    lightboxImage,
    lightboxIndex,
    visibleImages,
    activeLightboxImage,
    imagesBadge,
    setImageStatus,
    setImageCollection,
    openLightbox,
    changeLightbox,
    closeLightbox,
    handleLightboxKeydown,
    loadBrowserImageDirectory,
    openImageDirectory,
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
export const imageGroups = session.imageGroups;
export const imageFiles = session.imageFiles;
export const selectedImageGroup = session.selectedImageGroup;
export const imageStatus = session.imageStatus;
export const imageStatusError = session.imageStatusError;
export const imageLoading = session.imageLoading;
export const lightboxImage = session.lightboxImage;
export const lightboxIndex = session.lightboxIndex;
export const visibleImages = session.visibleImages;
export const activeLightboxImage = session.activeLightboxImage;
export const imagesBadge = session.imagesBadge;
export const setImageStatus = session.setImageStatus;
export const setImageCollection = session.setImageCollection;
export const openLightbox = session.openLightbox;
export const changeLightbox = session.changeLightbox;
export const closeLightbox = session.closeLightbox;
export const handleLightboxKeydown = session.handleLightboxKeydown;
export const loadBrowserImageDirectory = session.loadBrowserImageDirectory;
export const openImageDirectory = session.openImageDirectory;
