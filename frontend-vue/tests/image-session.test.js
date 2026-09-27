/*
 * Unit tests for the Image Viewer session: collection normalization, group
 * selection, the badge, the lightbox controls, and both pickers (native and
 * browser directory input).
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  activeLightboxImage,
  changeLightbox,
  closeLightbox,
  handleLightboxKeydown,
  imageDirectoryInput,
  imageDirectoryName,
  imageFiles,
  imageGroups,
  imageLoading,
  imageStatus,
  imageStatusError,
  imagesBadge,
  lightboxImage,
  lightboxIndex,
  loadBrowserImageDirectory,
  openImageDirectory,
  openLightbox,
  selectedImageGroup,
  setImageCollection,
  setImageStatus,
  visibleImages,
} from '../src/image-session.js';

const originalWindow = globalThis.window;

globalThis.document = { querySelector: () => null };
globalThis.FileReader = class {
  #handlers = {};
  result = '';
  error = null;

  addEventListener(type, handler) {
    this.#handlers[type] = handler;
  }

  readAsDataURL(file) {
    this.result = `data:${file.type || 'image/png'};base64,${file.payload || ''}`;
    this.#handlers.load?.();
  }
};

after(() => {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  delete globalThis.document;
  delete globalThis.FileReader;
});

const photo = (name, folder = 'photos') => ({
  name,
  relativePath: `${folder}/${name}`,
  dataUrl: `data:image/png;base64,${name}`,
});

test('installing a collection filters, groups, and reports the count', () => {
  setImageCollection(
    [
      photo('a.png'),
      photo('b.png'),
      { name: 'c.png', relativePath: 'photos/c.png' },
      photo('d.jpg', 'shots'),
      { name: 'notes.txt', relativePath: 'photos/notes.txt' },
    ],
    'Holidays',
  );

  /* Entries without a data URL (c.png, notes.txt) never reach the grid. */
  assert.equal(imageFiles.value.length, 3);
  assert.equal(imageDirectoryName.value, 'Holidays');
  assert.equal(imageStatus.value, '3 images found.');
  assert.equal(imageStatusError.value, false);

  const names = imageGroups.value.map((group) => group.name);
  assert.deepEqual(names, ['All Images', 'photos', 'shots']);
  assert.equal(imageGroups.value[0].images.length, 3);
  assert.equal(imageGroups.value[1].images.length, 2);
  assert.equal(imageGroups.value[2].images.length, 1);
});

test('an unnamed collection still gets a directory label', () => {
  setImageCollection([], '');
  assert.equal(imageDirectoryName.value, 'Selected directory');
  assert.equal(imageStatus.value, '0 images found.');

  setImageCollection('not-an-array', 'Folder');
  assert.equal(imageFiles.value.length, 0);
});

test('the selected group survives only while it still exists', () => {
  setImageCollection([photo('a.png'), photo('b.jpg', 'shots')], 'Trip');
  selectedImageGroup.value = 'shots';
  assert.equal(selectedImageGroup.value, 'shots');
  assert.equal(visibleImages.value.length, 1);

  setImageCollection([photo('a.png')], 'Trip');
  assert.equal(selectedImageGroup.value, 'All Images');
  assert.equal(visibleImages.value.length, 1);
});

test('the menu badge summarizes folder and count', () => {
  setImageCollection([], 'Holidays');
  assert.equal(imagesBadge.value, 'Holidays · re-select to reload');

  setImageCollection([photo('a.png')], 'Holidays');
  assert.equal(imagesBadge.value, 'Holidays · 1 image');

  setImageCollection([photo('a.png'), photo('b.png')], 'Holidays');
  assert.equal(imagesBadge.value, 'Holidays · 2 images');

  /* With no folder and no images the card invites the first pick. */
  imageDirectoryName.value = '';
  imageFiles.value = [];
  assert.equal(imagesBadge.value, 'Browse images grouped by folder');
});

test('the lightbox opens, wraps, and closes over the visible list', () => {
  const [first, second] = [photo('a.png'), photo('b.png')];
  setImageCollection([first, second], 'Holidays');

  openLightbox(second);
  assert.equal(lightboxImage.value?.name, 'b.png');
  assert.equal(lightboxIndex.value, 1);
  assert.equal(activeLightboxImage.value?.name, 'b.png');

  changeLightbox(1);
  assert.equal(lightboxImage.value?.name, 'a.png');
  assert.equal(lightboxIndex.value, 0);

  changeLightbox(-1);
  assert.equal(lightboxImage.value?.name, 'b.png');
  assert.equal(lightboxIndex.value, 1);

  closeLightbox();
  assert.equal(lightboxImage.value, null);
  assert.equal(lightboxIndex.value, -1);
  assert.equal(activeLightboxImage.value, null);
});

test('the lightbox ignores images outside the visible list', () => {
  setImageCollection([photo('a.png')], 'Holidays');
  const stranger = photo('stranger.png');
  lightboxImage.value = null;
  lightboxIndex.value = -1;

  openLightbox(stranger);
  assert.equal(lightboxImage.value, null);
  assert.equal(lightboxIndex.value, -1);
});

test('keyboard handling drives the lightbox', () => {
  setImageCollection([photo('a.png'), photo('b.png')], 'Holidays');
  openLightbox(imageFiles.value[0]);

  handleLightboxKeydown({ key: 'ArrowRight' });
  assert.equal(lightboxImage.value?.name, 'b.png');

  handleLightboxKeydown({ key: 'ArrowLeft' });
  assert.equal(lightboxImage.value?.name, 'a.png');

  handleLightboxKeydown({ key: 'Escape' });
  assert.equal(lightboxImage.value, null);

  handleLightboxKeydown({ key: 'ArrowRight' });
  assert.equal(lightboxImage.value, null);

  lightboxIndex.value = 0;
  handleLightboxKeydown({ key: 'Enter' });
  assert.equal(lightboxImage.value, null);
});

test('without a host binding the picker opens the hidden input', async () => {
  globalThis.window = {};
  let clicked = 0;
  imageDirectoryInput.value = {
    click() {
      clicked += 1;
    },
  };

  await openImageDirectory();

  assert.equal(clicked, 1);
  assert.equal(imageLoading.value, false);
  imageDirectoryInput.value = null;
});

test('the native picker reports errors, cancellation, and empty results', async () => {
  globalThis.window = {
    openImageDirectory: async () => {
      throw new Error('The folder could not be opened.');
    },
  };
  await openImageDirectory();
  assert.equal(imageStatus.value, 'The folder could not be opened.');
  assert.equal(imageStatusError.value, true);
  assert.equal(imageLoading.value, false);

  globalThis.window = {
    openImageDirectory: async () => ({ canceled: true }),
  };
  await openImageDirectory();
  assert.equal(imageStatus.value, 'Directory selection was cancelled.');
  assert.equal(imageStatusError.value, false);

  globalThis.window = {
    openImageDirectory: async () => ({
      name: 'Holidays',
      images: [photo('a.png')],
    }),
  };
  await openImageDirectory();
  assert.equal(imageDirectoryName.value, 'Holidays');
  assert.equal(imageFiles.value.length, 1);
  assert.equal(imageStatus.value, '1 image found.');

  globalThis.window = {
    openImageDirectory: async () => ({ name: 'Empty', images: [] }),
  };
  await openImageDirectory();
  assert.equal(
    imageStatus.value,
    'No supported images were found within the directory limits.',
  );
  assert.equal(imageStatusError.value, true);
  assert.equal(imageLoading.value, false);

  globalThis.window = {};
});

test('the browser directory input filters, caps, and reports skips', async () => {
  const files = [
    { name: 'a.png', size: 10, webkitRelativePath: 'Holidays/a.png' },
    { name: 'b.jpg', size: 10, webkitRelativePath: 'Holidays/b.jpg' },
    { name: 'readme.txt', size: 10, webkitRelativePath: 'Holidays/readme.txt' },
    {
      name: 'huge.png',
      size: 16 * 1024 * 1024 + 1,
      webkitRelativePath: 'Holidays/huge.png',
    },
  ];
  const target = { files, value: 'x' };

  await loadBrowserImageDirectory({ target });

  assert.equal(imageFiles.value.length, 2);
  assert.equal(imageDirectoryName.value, 'Holidays');
  assert.equal(
    imageStatus.value,
    '2 images loaded; 1 skipped by browser limits.',
  );
  assert.equal(imageLoading.value, false);
  assert.equal(target.value, '');
});

test('an unreadable directory is reported instead of showing a blank grid', async () => {
  const target = {
    files: [
      {
        name: 'readme.txt',
        size: 1,
        webkitRelativePath: 'Holidays/readme.txt',
      },
    ],
    value: 'x',
  };

  await loadBrowserImageDirectory({ target });

  assert.equal(imageFiles.value.length, 0);
  assert.equal(
    imageStatus.value,
    'No supported images were found in this directory.',
  );
  assert.equal(imageStatusError.value, true);
  assert.equal(imageLoading.value, false);
});

test('an empty file list leaves the session untouched', async () => {
  setImageCollection([photo('keep.png')], 'Holidays');
  await loadBrowserImageDirectory({ target: { files: [], value: 'x' } });
  assert.equal(imageFiles.value.length, 1);
  assert.equal(imageLoading.value, false);
});

test('the status helper records its error flag', () => {
  setImageStatus('done');
  assert.equal(imageStatus.value, 'done');
  assert.equal(imageStatusError.value, false);

  setImageStatus('failed', true);
  assert.equal(imageStatusError.value, true);
});
