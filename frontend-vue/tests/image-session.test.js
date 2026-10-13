/*
 * Unit tests for the Image Viewer session: collection normalization, group
 * selection, the badge, the lightbox controls, the remembered-path list, and
 * every way a directory is opened (native picker, remembered path, browser
 * directory input).
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  activeLightboxImage,
  changeLightbox,
  closeLightbox,
  createImageSession,
  handleLightboxKeydown,
  imageDirectoryInput,
  imageDirectoryName,
  imageDirectoryPath,
  imageFiles,
  imageGroups,
  imageLoading,
  imageRecentPaths,
  imageStatus,
  imageStatusError,
  imagesBadge,
  lightboxImage,
  lightboxIndex,
  loadBrowserImageDirectory,
  openImageDirectory,
  openImageDirectoryAt,
  openLightbox,
  rememberImagePath,
  selectedImageGroup,
  setImageCollection,
  setImageStatus,
  visibleImages,
} from '../src/image-session.js';
import { MAX_RECENT_PATHS } from '../src/workspace.js';

/* A boot snapshot with nothing restored, so a fresh session starts empty. */
const emptyBoot = () => ({
  view: 'menu',
  toc: { items: [], activeId: null, drafts: {} },
  editor: { content: '', title: '' },
  pdf: { name: '', page: 1, zoom: 1, recentPaths: [] },
  images: {
    directoryName: '',
    directoryPath: '',
    selectedGroup: '',
    recentPaths: [],
  },
  places: [],
});

/* Two microtask turns: the fetch is one await inside the session. */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

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

/*
 * A scanned image now carries a downscaled `thumbnail` plus the `path` the
 * lightbox asks for, and no longer carries the original's bytes. `dataUrl` is
 * kept alongside so the tests below that only care about identity still read a
 * recognisable string; the native scan no longer sends it.
 */
const photo = (name, folder = 'photos') => ({
  name,
  relativePath: `${folder}/${name}`,
  path: `/photos/${folder}/${name}`,
  thumbnail: `data:image/jpeg;base64,thumb-${name}`,
  width: 320,
  height: 240,
  dataUrl: `data:image/jpeg;base64,thumb-${name}`,
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
  setImageCollection([photo('a.png')], 'Holidays');
  assert.equal(imagesBadge.value, 'Holidays · 1 image');

  setImageCollection([photo('a.png'), photo('b.png')], 'Holidays');
  assert.equal(imagesBadge.value, 'Holidays · 2 images');

  /* With no folder and no images the card invites the first pick. */
  imageDirectoryName.value = '';
  imageFiles.value = [];
  imageRecentPaths.value = [];
  assert.equal(imagesBadge.value, 'Browse images grouped by folder');
});

test('an empty viewer counts remembered directories instead of re-selecting', () => {
  imageFiles.value = [];
  imageRecentPaths.value = [];
  assert.equal(imagesBadge.value, 'Browse images grouped by folder');

  imageRecentPaths.value = ['/photos'];
  assert.equal(imagesBadge.value, '1 remembered directory');

  imageRecentPaths.value = ['/photos', '/art'];
  assert.equal(imagesBadge.value, '2 remembered directories');
});

test('a remembered directory is moved to the front without duplicating it', () => {
  imageRecentPaths.value = ['/a', '/b'];

  rememberImagePath('/b');
  assert.deepEqual(imageRecentPaths.value, ['/b', '/a']);

  rememberImagePath('/c');
  assert.deepEqual(imageRecentPaths.value, ['/c', '/b', '/a']);
});

test('an empty remembered directory path is ignored', () => {
  imageRecentPaths.value = ['/a'];

  rememberImagePath('');
  rememberImagePath('  ');
  rememberImagePath(undefined);

  assert.deepEqual(imageRecentPaths.value, ['/a']);
});

test('the remembered directory list stops growing at the schema cap', () => {
  imageRecentPaths.value = Array.from(
    { length: MAX_RECENT_PATHS },
    (_, index) => `/old-${index}`,
  );

  rememberImagePath('/new');

  assert.equal(imageRecentPaths.value.length, MAX_RECENT_PATHS);
  assert.equal(imageRecentPaths.value[0], '/new');
  assert.equal(
    imageRecentPaths.value.includes(`/old-${MAX_RECENT_PATHS - 1}`),
    false,
    'the least recently used entry is the one dropped',
  );
  assert.equal(imageRecentPaths.value.includes('/old-0'), true);
});

test('re-opening a remembered directory asks the host and records the answer', async () => {
  imageFiles.value = [];
  imageRecentPaths.value = ['/photos'];
  const asked = [];
  globalThis.window = {
    openImageDirectoryAt: (path) => {
      asked.push(path);
      return Promise.resolve({
        name: 'photos',
        path,
        images: [photo('a.png')],
      });
    },
  };

  await openImageDirectoryAt('/photos');

  assert.deepEqual(asked, ['/photos']);
  assert.equal(imageDirectoryPath.value, '/photos');
  assert.equal(imageFiles.value.length, 1);
  assert.deepEqual(imageRecentPaths.value, ['/photos']);
  assert.equal(imageLoading.value, false);
  globalThis.window = {};
});

test('a remembered directory the host cannot scan is dropped', async () => {
  imageFiles.value = [];
  imageRecentPaths.value = ['/gone', '/kept'];
  globalThis.window = {
    openImageDirectoryAt: () =>
      Promise.reject({ error: { code: 'NO_IMAGES', message: 'empty' } }),
  };

  await openImageDirectoryAt('/gone');

  assert.deepEqual(imageRecentPaths.value, ['/kept']);
  assert.equal(imageLoading.value, false);
  globalThis.window = {};
});

test('re-opening a remembered directory is desktop-only', async () => {
  imageRecentPaths.value = ['/photos'];
  globalThis.window = {};

  await openImageDirectoryAt('/photos');

  assert.equal(
    imageStatus.value,
    'Opening a remembered directory is available in the desktop app.',
  );
  assert.deepEqual(imageRecentPaths.value, ['/photos']);
  globalThis.window = {};
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

test('a truncated scan and full-size fallbacks say so in the status', async () => {
  globalThis.window = {
    openImageDirectory: async () => ({
      name: 'Holidays',
      path: '/photos',
      images: [photo('a.png')],
      limited: true,
      fallbacks: 0,
    }),
  };
  await openImageDirectory();
  assert.equal(
    imageStatus.value,
    '1 image found. · showing a partial scan; directory limits were reached',
  );

  globalThis.window = {
    openImageDirectory: async () => ({
      name: 'Holidays',
      path: '/photos',
      images: [photo('a.png'), photo('b.png')],
      limited: false,
      fallbacks: 1,
    }),
  };
  await openImageDirectory();
  assert.equal(
    imageStatus.value,
    '2 images found. · 1 image sent full-size (no thumbnail)',
  );

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

test('one image plus one skip reads as singular, not "1 images"', async () => {
  const files = [
    { name: 'a.png', size: 10, webkitRelativePath: 'Holidays/a.png' },
    {
      name: 'huge.png',
      size: 16 * 1024 * 1024 + 1,
      webkitRelativePath: 'Holidays/huge.png',
    },
  ];
  const target = { files, value: 'x' };

  await loadBrowserImageDirectory({ target });

  assert.equal(imageFiles.value.length, 1);
  assert.equal(
    imageStatus.value,
    '1 image loaded; 1 skipped by browser limits.',
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

/*
 * The lightbox is the only view that shows an image larger than a thumbnail, so
 * it is the only one that fetches the original. These cover that fetch and the
 * fact that it is released again, because a full-size data URL held per image is
 * the exact memory this change removed from the grid.
 */
test('a collection of thumbnails is accepted where originals used to be', () => {
  setImageCollection(
    [
      {
        name: 'a.png',
        relativePath: 'p/a.png',
        thumbnail: 'data:image/jpeg;base64,t',
      },
      // A host that predates the field still renders.
      {
        name: 'b.png',
        relativePath: 'p/b.png',
        dataUrl: 'data:image/png;base64,b',
      },
    ],
    'Holidays',
  );
  assert.equal(imageFiles.value.length, 2);
});

test('opening the lightbox fetches the full-size image by path', async () => {
  const asked = [];
  const session = createImageSession({
    boot: emptyBoot(),
    doc: { querySelector: () => null },
    native: (name) => {
      if (name !== 'loadImageAt') return null;
      return (path) => {
        asked.push(path);
        return { ok: true, dataUrl: `data:image/jpeg;base64,full-${path}` };
      };
    },
  });
  const [first, second] = [photo('a.png'), photo('b.png')];
  session.setImageCollection([first, second], 'Holidays');

  session.openLightbox(second);
  await settle();
  assert.deepEqual(asked, ['/photos/photos/b.png']);
  assert.equal(
    session.lightboxFullSizeUrl.value,
    'data:image/jpeg;base64,full-/photos/photos/b.png',
  );
});

test('stepping never holds two full-size images at once', async () => {
  // A full-resolution data URL is the memory this change took out of the grid, so
  // the lightbox must not reintroduce it by accumulating. Observed at the instant
  // after the step, before the new fetch resolves: the old URL must already be
  // gone, or the previous image is still resident while the next loads.
  const pending = [];
  const session = createImageSession({
    boot: emptyBoot(),
    doc: { querySelector: () => null },
    native: (name) =>
      name === 'loadImageAt'
        ? (path) =>
            new Promise((resolve) => {
              pending.push(() =>
                resolve({
                  ok: true,
                  dataUrl: `data:image/jpeg;base64,full-${path}`,
                }),
              );
            })
        : null,
  });
  const [first, second] = [photo('a.png'), photo('b.png')];
  session.setImageCollection([first, second], 'Holidays');

  session.openLightbox(first);
  pending.shift()?.();
  await settle();
  assert.match(session.lightboxFullSizeUrl.value, /a\.png/);

  // Step while the next fetch is still in flight: only one URL may be held.
  session.changeLightbox(1);
  assert.equal(
    session.lightboxFullSizeUrl.value,
    '',
    'the previous full-size image is still resident while the next loads',
  );
  assert.equal(session.lightboxFullSizeLoading.value, true);
  pending.shift()?.();
  await settle();
  assert.match(session.lightboxFullSizeUrl.value, /b\.png/);
});

test('closing the lightbox releases the full-size image', async () => {
  const session = createImageSession({
    boot: emptyBoot(),
    doc: { querySelector: () => null },
    native: (name) =>
      name === 'loadImageAt'
        ? () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,full' })
        : null,
  });
  session.setImageCollection([photo('a.png')], 'Holidays');
  session.openLightbox(session.imageFiles.value[0]);
  await settle();
  assert.ok(session.lightboxFullSizeUrl.value.length > 0);
  session.closeLightbox();
  assert.equal(session.lightboxFullSizeUrl.value, '');
  assert.equal(session.lightboxFullSizeLoading.value, false);
});

test('without a host the lightbox keeps the thumbnail and does not fail', async () => {
  // The browser preview has no loadImageAt binding. The thumbnail stays, which is
  // the whole image there, and nothing is reported as broken.
  const session = createImageSession({
    boot: emptyBoot(),
    doc: { querySelector: () => null },
    native: () => null,
  });
  session.setImageCollection([photo('a.png')], 'Holidays');
  session.openLightbox(session.imageFiles.value[0]);
  await settle();
  assert.equal(session.lightboxImage.value?.name, 'a.png');
  assert.equal(session.lightboxFullSizeUrl.value, '');
});

test('a failed full-size fetch leaves the thumbnail in place', async () => {
  const session = createImageSession({
    boot: emptyBoot(),
    doc: { querySelector: () => null },
    native: (name) =>
      name === 'loadImageAt'
        ? () => {
            throw new Error('the file moved');
          }
        : null,
  });
  session.setImageCollection([photo('a.png')], 'Holidays');
  session.openLightbox(session.imageFiles.value[0]);
  await settle();
  // No full-size URL, but the lightbox is still showing the image.
  assert.equal(session.lightboxFullSizeUrl.value, '');
  assert.equal(session.lightboxImage.value?.name, 'a.png');
  assert.equal(session.lightboxFullSizeLoading.value, false);
});
