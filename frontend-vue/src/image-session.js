/*
 * Image Viewer session: folder selection, grouping, and the lightbox.
 *
 * Two sources feed the same state: the native folder picker (desktop) and a
 * webkitdirectory input (browser). Both end in setImageCollection(), which
 * normalizes, groups, and reports what was found.
 */
import { computed, nextTick, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { groupImages, imagesFromFileList } from './image-viewer.js';
import { getNativeBinding, runNativeCall } from './native-bridge.js';

/* --- selection state ------------------------------------------------------ */

export const imageDirectoryInput = ref(null);
export const imageDirectoryName = ref(restoredWorkspace.images.directoryName);
export const imageGroups = ref([]);
export const imageFiles = ref([]);
export const selectedImageGroup = ref(restoredWorkspace.images.selectedGroup);
export const imageStatus = ref('Choose a parent directory to find images.');
export const imageStatusError = ref(false);
export const imageLoading = ref(false);

/* --- lightbox ------------------------------------------------------------- */

export const lightboxImage = ref(null);
export const lightboxIndex = ref(-1);

/* Images of the selected group ("All Images" shows the flat list). */
export const visibleImages = computed(() => {
  if (selectedImageGroup.value === 'All Images') return imageFiles.value;
  return (
    imageGroups.value.find((group) => group.name === selectedImageGroup.value)
      ?.images || []
  );
});

export const activeLightboxImage = computed(() =>
  lightboxImage.value ? visibleImages.value[lightboxIndex.value] : null,
);

/* --- status --------------------------------------------------------------- */

export function setImageStatus(message, isError = false) {
  imageStatus.value = message;
  imageStatusError.value = isError;
}

/* --- collections ---------------------------------------------------------- */

/*
 * Installs a new result set, keeps the selected group when it still exists,
 * and reports how many images were accepted.
 */
export function setImageCollection(images, directoryName) {
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

export function openLightbox(image) {
  lightboxIndex.value = visibleImages.value.indexOf(image);
  if (lightboxIndex.value >= 0) {
    lightboxImage.value = image;
    nextTick(() => document.querySelector('.lightbox')?.focus());
  }
}

export function changeLightbox(offset) {
  if (visibleImages.value.length === 0) return;
  lightboxIndex.value =
    (lightboxIndex.value + offset + visibleImages.value.length) %
    visibleImages.value.length;
  lightboxImage.value = visibleImages.value[lightboxIndex.value];
}

export function closeLightbox() {
  lightboxImage.value = null;
  lightboxIndex.value = -1;
}

export function handleLightboxKeydown(event) {
  if (!lightboxImage.value) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') changeLightbox(-1);
  if (event.key === 'ArrowRight') changeLightbox(1);
}

/* --- sources -------------------------------------------------------------- */

/* Browser fallback: reads the chosen directory from the file list input. */
export async function loadBrowserImageDirectory(event) {
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

/*
 * Native folder picker when the host provides it, browser directory input
 * otherwise. Empty results are reported rather than shown as a blank grid.
 */
export async function openImageDirectory() {
  const openDirectory = getNativeBinding('openImageDirectory');
  if (!openDirectory) {
    imageDirectoryInput.value?.click();
    return;
  }
  imageLoading.value = true;
  setImageStatus('Waiting for the system directory picker…');
  try {
    const result = await runNativeCall(openDirectory);
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
  } finally {
    imageLoading.value = false;
  }
}

/* Menu badge: folder and count of the current selection. */
export const imagesBadge = computed(() => {
  if (imageFiles.value.length > 0) {
    const count = `${imageFiles.value.length} image${imageFiles.value.length === 1 ? '' : 's'}`;
    return `${imageDirectoryName.value || 'Folder'} · ${count}`;
  }
  if (imageDirectoryName.value) {
    return `${imageDirectoryName.value} · re-select to reload`;
  }
  return 'Browse images grouped by folder';
});
