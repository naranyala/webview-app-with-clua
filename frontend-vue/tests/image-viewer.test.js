/*
 * Unit tests for the pure Image Viewer helpers: extension recognition,
 * folder grouping from relative paths, and the leading "All Images" group.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupImages,
  imageExtension,
  imageGroupFromRelativePath,
  imagesFromFileList,
  MAX_BROWSER_TOTAL_SIZE,
  makeThumbnail,
  THUMBNAIL_MAX_EDGE,
} from '../src/image-viewer.js';

test('common image extensions are recognized case-insensitively', () => {
  assert.equal(imageExtension('photo.JPEG'), '.jpeg');
  assert.equal(imageExtension('diagram.svg'), '.svg');
  assert.equal(imageExtension('notes.txt'), '');
});

test('relative paths produce folder groups without exposing a root path', () => {
  assert.equal(
    imageGroupFromRelativePath('holiday/day/beach.JPG'),
    'holiday / day',
  );
  assert.equal(imageGroupFromRelativePath('cover.png'), 'Root');
  assert.equal(imageGroupFromRelativePath('one\\two\\image.webp'), 'one / two');
});

test('groups always include all images first', () => {
  const images = [
    { name: 'a.png', relativePath: 'a.png' },
    { name: 'b.jpg', relativePath: 'inner/b.jpg' },
    { name: 'c.png', relativePath: 'inner/c.png' },
  ];
  const groups = groupImages(images);
  assert.equal(groups[0].name, 'All Images');
  assert.equal(groups[0].images.length, 3);
  const inner = groups.find((group) => group.name === 'inner');
  assert.equal(inner.images.length, 2);
});

/*
 * The browser fallback must honour the same three budgets the native scan
 * does. It previously capped the count and the per-file size but not the
 * total, so 500 accepted files could become ~8 GB of base64 data URLs.
 */
/*
 * imagesFromFileList reads each file through image-viewer's own data-URL
 * reader, so the tests stub that one seam rather than a real FileReader.
 */
function stubFileReader() {
  const saved = globalThis.FileReader;
  // The reader this module expects: addEventListener + readAsDataURL.
  globalThis.FileReader = class {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }
    readAsDataURL() {
      this.result = 'data:image/png;base64,stub';
      this.listeners.get('load')?.();
    }
  };
  return () => {
    if (saved === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = saved;
  };
}

test('imagesFromFileList stops at the total byte budget like the native scan', async () => {
  const restore = stubFileReader();
  try {
    const big = 16 * 1024 * 1024;
    const files = Array.from({ length: 8 }, (_, index) => ({
      name: `shot-${index}.png`,
      size: big,
      webkitRelativePath: `folder/shot-${index}.png`,
    }));
    const result = await imagesFromFileList(files);
    // 96 MB / 16 MB = 6 files, and the two that did not fit are reported.
    assert.equal(result.images.length, 6);
    assert.equal(result.totalBytes, 6 * big);
    assert.equal(result.skipped, 2);
  } finally {
    restore();
  }
});

test('a file larger than the per-file budget is still rejected', async () => {
  const restore = stubFileReader();
  try {
    const result = await imagesFromFileList([
      { name: 'huge.png', size: MAX_BROWSER_TOTAL_SIZE + 1 },
    ]);
    assert.equal(result.images.length, 0);
    assert.equal(result.oversized, 1);
  } finally {
    restore();
  }
});

/*
 * Thumbnails. The whole point of the change is that the grid holds a downscaled
 * copy rather than the original, because the grid renders at 140px tall and a
 * 12 MP photo is ~120 MB of base64 across a collection.
 */

/* A canvas stand-in: enough surface for makeThumbnail to drive. */
function stubCanvas({ toDataURL = 'data:image/jpeg;base64,thumb' } = {}) {
  const drawn = [];
  return {
    drawn,
    element: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect: () => {},
        drawImage: (_bitmap, _x, _y, w, h) => drawn.push({ w, h }),
      }),
      toDataURL: () => toDataURL,
    }),
  };
}

const bitmapOf = (width, height) => ({
  width,
  height,
  close() {},
});

test('makeThumbnail scales the long edge to the thumbnail size', async () => {
  const canvas = stubCanvas();
  const thumbnail = makeThumbnail(async () => bitmapOf(4032, 3024), {
    createElement: canvas.element,
  });
  const result = await thumbnail({});
  assert.equal(result.width, THUMBNAIL_MAX_EDGE);
  assert.equal(result.height, 240, '4032x3024 becomes 320x240, aspect kept');
  assert.match(result.dataUrl, /^data:image\/jpeg/);
});

test('makeThumbnail scales a portrait on its long edge too', async () => {
  const canvas = stubCanvas();
  const thumbnail = makeThumbnail(async () => bitmapOf(3000, 4000), {
    createElement: canvas.element,
  });
  const result = await thumbnail({});
  assert.equal(result.width, 240);
  assert.equal(result.height, THUMBNAIL_MAX_EDGE);
});

test('makeThumbnail never upscales a small image', async () => {
  const canvas = stubCanvas();
  const thumbnail = makeThumbnail(async () => bitmapOf(200, 150), {
    createElement: canvas.element,
  });
  const result = await thumbnail({});
  // dataUrl null means "use the original", which is right for a small image:
  // re-encoding it smaller would cost bytes and add nothing.
  assert.equal(result.dataUrl, null);
  assert.equal(result.width, 200);
  assert.equal(
    canvas.drawn.length,
    0,
    'nothing was drawn, so nothing was re-encoded',
  );
});

test('makeThumbnail reports failure rather than throwing when it cannot decode', async () => {
  const failing = makeThumbnail(
    async () => {
      throw new Error('unsupported format');
    },
    { createElement: () => ({}) },
  );
  assert.equal(await failing({}), null);

  // No createImageBitmap at all: the same answer, so the caller falls back.
  const absent = makeThumbnail(undefined, undefined);
  assert.equal(await absent({}), null);
});

test('imagesFromFileList prefers a thumbnail over the original bytes', async () => {
  const restore = stubFileReader();
  try {
    const canvas = stubCanvas();
    const thumbnail = makeThumbnail(async () => bitmapOf(4032, 3024), {
      createElement: canvas.element,
    });
    const result = await imagesFromFileList(
      [
        {
          name: 'photo.jpg',
          size: 300 * 1024,
          webkitRelativePath: 'trip/photo.jpg',
        },
      ],
      { thumbnail },
    );
    assert.equal(result.images.length, 1);
    // The grid reads `thumbnail`; the original was never read, so the stubbed
    // FileReader's data URL is not what the image carries.
    assert.equal(result.images[0].thumbnail, 'data:image/jpeg;base64,thumb');
    assert.equal(result.images[0].width, THUMBNAIL_MAX_EDGE);
    assert.equal(result.fallbacks, 0, 'nothing needed the original');
  } finally {
    restore();
  }
});

test('imagesFromFileList falls back to the original and says so', async () => {
  const restore = stubFileReader();
  try {
    // No thumbnail function, as in a plain-node test or an environment with no
    // createImageBitmap: the image must still appear, and the reply must admit
    // that it is carrying full-resolution bytes.
    const result = await imagesFromFileList([
      { name: 'photo.jpg', size: 1024, webkitRelativePath: 'photo.jpg' },
    ]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].thumbnail, 'data:image/png;base64,stub');
    assert.equal(result.fallbacks, 1);
  } finally {
    restore();
  }
});
