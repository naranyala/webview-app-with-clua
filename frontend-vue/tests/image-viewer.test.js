import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupImages,
  imageExtension,
  imageGroupFromRelativePath,
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
