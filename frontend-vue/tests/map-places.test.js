/*
 * Unit tests for the Explorer's saved places: the collection, its rules, and the
 * view options that travel with it.
 *
 * The rules that matter are the ones that protect the list from becoming
 * unusable: a place needs a name, a repeat pick does not create a duplicate, the
 * cap is enforced, and a corrupt stored record degrades to nothing rather than to
 * a row the reader cannot delete.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapExplorer, MAP_FILTERS } from '../src/map-explorer.js';
import { createMapPlaces } from '../src/map-places.js';
import {
  MAX_PLACE_LABEL,
  MAX_SAVED_PLACES,
  normalizePlace,
  normalizePlaces,
} from '../src/workspace.js';

const boot = (places = [], map = {}) => ({ map: { places, ...map } });

test('a place needs both a usable coordinate and a name', () => {
  assert.ok(normalizePlace({ lat: 1, lon: 2, label: 'Gate' }), 'a real place');
  assert.equal(
    normalizePlace({ lat: 1, lon: 2, label: '  ' }),
    null,
    'no name',
  );
  assert.equal(
    normalizePlace({ lat: 400, lon: 2, label: 'Gate' }),
    null,
    'bad lat',
  );
  assert.equal(
    normalizePlace({ lat: 1, lon: 'x', label: 'Gate' }),
    null,
    'bad lon',
  );
  assert.equal(normalizePlace(null), null);
  assert.equal(
    normalizePlace({ lat: 1, lon: 2, label: 'x'.repeat(500) }).label.length,
    MAX_PLACE_LABEL,
    'the label is bounded',
  );
});

test('a stored list drops broken rows and duplicate ids', () => {
  const places = normalizePlaces([
    { id: 'a', lat: 1, lon: 2, label: 'One' },
    { id: 'a', lat: 3, lon: 4, label: 'Clash' },
    { lat: 5, lon: 6, label: '' },
    'garbage',
    { id: 'b', lat: 7, lon: 8, label: 'Two' },
  ]);
  assert.deepEqual(
    places.map((place) => place.label),
    ['One', 'Two'],
    'a duplicate id would make every rename hit two rows',
  );
  assert.deepEqual(normalizePlaces('not a list'), []);
});

test('the stored list stops at the schema cap', () => {
  const many = Array.from({ length: MAX_SAVED_PLACES + 25 }, (_, index) => ({
    id: `p${index}`,
    lat: 1,
    lon: 2,
    label: `Place ${index}`,
  }));
  assert.equal(normalizePlaces(many).length, MAX_SAVED_PLACES);
});

test('saving a place stores the coordinates and reports the count', () => {
  const places = createMapPlaces({ boot: boot(), now: () => 42 });

  const saved = places.addPlace({
    lat: 51.5073514,
    lon: -0.1277584,
    label: 'London',
  });

  assert.equal(saved.label, 'London');
  assert.equal(saved.lat, 51.507351, 'rounded like every other coordinate');
  assert.equal(places.placeCount.value, 1);
  assert.match(places.placeStatus.value, /Saved “London”\. 1 place\./);
  assert.equal(places.placeStatusError.value, false);
});

test('a place with no name or no coordinate is refused', () => {
  const places = createMapPlaces({ boot: boot() });

  assert.equal(places.addPlace({ lat: 1, lon: 2, label: '   ' }), null);
  assert.match(places.placeStatus.value, /name/);
  assert.equal(places.addPlace({ lat: 900, lon: 2, label: 'Nowhere' }), null);
  assert.equal(places.placeCount.value, 0);
});

test('re-picking a saved place moves it up instead of duplicating it', () => {
  const places = createMapPlaces({
    boot: boot([
      { id: 'a', lat: 1, lon: 2, label: 'First' },
      { id: 'b', lat: 3, lon: 4, label: 'Second' },
    ]),
  });

  const again = places.addPlace({ lat: 3, lon: 4, label: 'Second' });

  assert.equal(again.id, 'b', 'the existing record is returned');
  assert.equal(places.placeCount.value, 2, 'no near-duplicate was created');
  assert.deepEqual(
    places.places.value.map((place) => place.id),
    ['b', 'a'],
    'and it is now first',
  );
  assert.match(places.placeStatus.value, /already saved/);
});

test('the list refuses to grow past the cap', () => {
  const full = Array.from({ length: MAX_SAVED_PLACES }, (_, index) => ({
    id: `p${index}`,
    lat: 1,
    lon: 2,
    label: `Place ${index}`,
  }));
  const places = createMapPlaces({ boot: boot(full) });

  const saved = places.addPlace({ lat: 50, lon: 50, label: 'One too many' });

  assert.equal(saved, null);
  assert.equal(places.placeCount.value, MAX_SAVED_PLACES);
  assert.match(places.placeStatus.value, /Remove one before saving another/);
});

test('renaming keeps the position and the coordinates', () => {
  const places = createMapPlaces({
    boot: boot([
      { id: 'a', lat: 1, lon: 2, label: 'Old' },
      { id: 'b', lat: 3, lon: 4, label: 'Other' },
    ]),
  });

  const renamed = places.renamePlace('a', '  New name  ');

  assert.equal(renamed.label, 'New name');
  assert.equal(renamed.lat, 1, 'the coordinates are untouched');
  assert.deepEqual(
    places.places.value.map((place) => place.id),
    ['a', 'b'],
    'the row did not move',
  );
  assert.equal(places.renamePlace('a', '  '), null, 'an empty name is refused');
  assert.equal(
    places.renamePlace('missing', 'x'),
    null,
    'an unknown id is refused',
  );
});

test('removing and clearing report what is left', () => {
  const places = createMapPlaces({
    boot: boot([
      { id: 'a', lat: 1, lon: 2, label: 'One' },
      { id: 'b', lat: 3, lon: 4, label: 'Two' },
    ]),
  });

  assert.equal(places.removePlace('a').label, 'One');
  assert.equal(places.placeCount.value, 1);
  assert.match(places.placeStatus.value, /Removed “One”\. 1 place left\./);

  places.clearPlaces();
  assert.equal(places.placeCount.value, 0);
  assert.match(places.placeStatus.value, /Cleared every saved place/);
});

test('editing state is cleared when the row being edited goes away', () => {
  const places = createMapPlaces({
    boot: boot([{ id: 'a', lat: 1, lon: 2, label: 'One' }]),
  });

  places.startPlaceEdit('a');
  assert.equal(places.editingPlaceId.value, 'a');
  places.removePlace('a');
  assert.equal(places.editingPlaceId.value, null);

  places.startPlaceEdit('a');
  places.cancelPlaceEdit();
  assert.equal(places.editingPlaceId.value, null);
});

test('a save during an edit both renames and leaves the edit', () => {
  const places = createMapPlaces({
    boot: boot([{ id: 'a', lat: 1, lon: 2, label: 'Old' }]),
  });
  places.startPlaceEdit('a');

  const saved = places.savePlaceEdit('a', 'Fresh');

  assert.equal(saved.label, 'Fresh');
  assert.equal(places.editingPlaceId.value, null);
});

test('two place collections are independent', () => {
  const first = createMapPlaces({ boot: boot() });
  const second = createMapPlaces({ boot: boot() });

  first.addPlace({ lat: 1, lon: 2, label: 'Only mine' });

  assert.equal(first.placeCount.value, 1);
  assert.equal(second.placeCount.value, 0);
  assert.equal(second.placeStatusError.value, false);
});

test('a snapshot and apply round-trip the list', () => {
  const source = createMapPlaces({ boot: boot() });
  source.addPlace({ lat: 1, lon: 2, label: 'Kept' });

  const target = createMapPlaces({ boot: boot() });
  assert.equal(target.apply(source.snapshot()), true);
  assert.equal(target.placeCount.value, 1);
  assert.equal(target.places.value[0].label, 'Kept');
  assert.equal(target.apply(null), false, 'a missing snapshot is reported');
});

/* --- view options ---------------------------------------------------------- */

test('an unknown filter falls back to none rather than breaking the map', () => {
  const explorer = createMapExplorer({ boot: boot() });
  explorer.setMapFilter('grayscale');
  assert.equal(explorer.mapFilter.value, 'grayscale');
  /* A stored value from a newer build must not produce a class with no rules. */
  explorer.setMapFilter('not-a-filter');
  assert.equal(explorer.mapFilter.value, 'none');
  for (const name of MAP_FILTERS) {
    explorer.setMapFilter(name);
    assert.equal(explorer.mapFilter.value, name);
  }
});

test('the renderer toggles between dom and canvas and nothing else', () => {
  const explorer = createMapExplorer({ boot: boot() });
  assert.equal(explorer.mapRenderer.value, 'dom');
  explorer.setMapRenderer('canvas');
  assert.equal(explorer.mapRenderer.value, 'canvas');
  explorer.setMapRenderer('webgl');
  assert.equal(
    explorer.mapRenderer.value,
    'dom',
    'an unknown renderer is refused',
  );
});

test('view options start from the stored workspace', () => {
  const explorer = createMapExplorer({
    boot: boot([], {
      filter: 'dark',
      renderer: 'canvas',
      showGrid: true,
      showCursor: false,
      sidebarOpen: false,
    }),
  });
  assert.equal(explorer.mapFilter.value, 'dark');
  assert.equal(explorer.mapRenderer.value, 'canvas');
  assert.equal(explorer.mapShowGrid.value, true);
  assert.equal(explorer.mapShowCursor.value, false);
  assert.equal(explorer.mapSidebarOpen.value, false);
});

test('the sidebar toggles and turning the cursor off clears the readout', () => {
  const explorer = createMapExplorer({ boot: boot() });
  assert.equal(explorer.mapSidebarOpen.value, true, 'open by default');
  explorer.toggleMapSidebar();
  assert.equal(explorer.mapSidebarOpen.value, false);
  explorer.toggleMapSidebar();
  assert.equal(explorer.mapSidebarOpen.value, true);

  explorer.mapCursorLocation.value = { lat: 1, lon: 2, label: '' };
  explorer.setMapShowCursor(false);
  assert.equal(
    explorer.mapCursorLocation.value,
    null,
    'the readout is cleared',
  );
});

test('a marker offset is null before the viewport is measured', () => {
  const explorer = createMapExplorer({ boot: boot() });
  assert.equal(explorer.placeMarkerOffset({ lat: 1, lon: 2 }), null);
  assert.equal(explorer.placeMarkerOffset(null), null);
});
