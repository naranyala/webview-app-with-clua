/*
 * A section's location, and the map that is asked to show it.
 *
 * A location link is one of the three things a section can point at, and the only
 * one whose consumer lives in another session: attaching one has to satisfy the
 * map's own coordinate validation rather than the outline's, which is why it does
 * not belong in the outline's test file even though the outline owns the field.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { view } from '../src/app-shell.js';
import { mapPin, mapStatus, mapStatusError } from '../src/map-explorer.js';
import {
  activeTocId,
  attachLocationToToc,
  linkTargetId,
  openLinkedLocation,
} from '../src/toc-outline.js';
import { makeItem, resetOutline } from './support/toc-fixtures.mjs';

test('attaching a pin stores the coordinates on the selected section', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = { lat: 48.8584, lon: 2.2945, label: '' };
  attachLocationToToc();
  assert.deepEqual(item.links.location, {
    lat: 48.8584,
    lon: 2.2945,
    label: '',
  });
  assert.equal(mapStatus.value, 'Location attached to “Site visit”.');
  assert.equal(mapStatusError.value, false);
  mapPin.value = null;
});
test('attaching a location needs both a target and a pin', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = null;
  /* A pin, but no target. */
  linkTargetId.value = null;
  activeTocId.value = null;
  mapPin.value = { lat: 1, lon: 2, label: '' };
  attachLocationToToc();
  assert.equal(mapStatusError.value, true);
  assert.match(mapStatus.value, /Select an outline item/);
  assert.equal(item.links.location, null);
  /* A target, but no pin. */
  linkTargetId.value = item.id;
  mapPin.value = null;
  attachLocationToToc();
  assert.equal(mapStatusError.value, true);
  assert.match(mapStatus.value, /drop a pin/);
  assert.equal(item.links.location, null);
});
test('re-attaching replaces the previous place rather than adding one', () => {
  const item = makeItem({ title: 'Site visit' });
  item.links.location = { lat: 1, lon: 1, label: '' };
  resetOutline([item], item.id);
  mapPin.value = { lat: 10, lon: 20, label: '' };
  attachLocationToToc();
  assert.deepEqual(item.links.location, { lat: 10, lon: 20, label: '' });
  mapPin.value = null;
});
test('a stored location is copied, not aliased, into the outline', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  mapPin.value = { lat: 5, lon: 6, label: 'Fifth' };
  attachLocationToToc();
  /* Moving the pin afterwards must not rewrite what was attached. */
  mapPin.value = { lat: 99, lon: 99, label: 'Moved' };
  assert.equal(item.links.location.lat, 5);
  assert.equal(item.links.location.label, 'Fifth');
  mapPin.value = null;
});
test('jumping to a linked location travels to it in the explorer', async () => {
  /*
   * The outline's job here is to switch view and tell the map where to go; that
   * the map travels rather than teleports, and arrives at the right zoom, is the
   * map session's business and is covered in map-explorer.test.js. Asserting it
   * through the real session here would mean waiting on a 560ms animation.
   */
  const item = makeItem({ title: 'Site visit' });
  item.links.location = { lat: 48.8584, lon: 2.2945, label: 'Eiffel Tower' };
  resetOutline([item], item.id);
  openLinkedLocation(item);
  assert.equal(view.value, 'map');
  /* The pin is not moved yet: it lands with the journey, and only if the
     journey is not interrupted. */
  assert.equal(mapPin.value, null, 'the pin waits for the journey to land');
});
test('a linked location the map cannot read is reported', () => {
  const item = makeItem({ title: 'Site visit' });
  resetOutline([item], item.id);
  /* No location on the item: nothing to travel to, and no error either - a
     section simply need not be about a place. */
  openLinkedLocation(item);
  assert.equal(view.value, 'map');
  assert.equal(mapStatusError.value, false);
});
test('a section with no location opens the explorer without a pin', () => {
  const item = makeItem({ title: 'Empty' });
  resetOutline([item], item.id);
  mapPin.value = null;
  openLinkedLocation(item);
  assert.equal(mapPin.value, null);
});
