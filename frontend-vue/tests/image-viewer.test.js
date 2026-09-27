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
