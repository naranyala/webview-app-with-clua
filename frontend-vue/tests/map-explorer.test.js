/*
 * The Explorer specifically: the pin, the click-versus-drag threshold, saved places,
 * the badge, and the flights between places.
 *
 * What is left here once the pure geometry, the shared viewport, and the panes are
 * split out is what makes this the OpenStreetMap Explorer rather than a map - the
 * distinction the module split in TODO-093 was drawing. Unit tests for the session
 * modules live beside them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapExplorer } from '../src/map-explorer.js';
import { close, flyingExplorer } from './support/map-fixtures.mjs';

test('the session pins a clicked point without moving the map', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    clientWidth: 512,
    clientHeight: 512,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const centre = { lat: 0, lon: 0 };
  assert.deepEqual(explorer.mapCenter.value, centre);

  /*
   * A click in the top-left corner. The viewport's origin is half a viewport
   * north-west of the centre, which at zoom 4 is 256px, or 22.5 degrees of
   * longitude, and a little under 22 degrees of latitude.
   */
  assert.equal(explorer.pickMapLocation({ clientX: 0, clientY: 0 }), true);
  const location = explorer.mapPin.value;
  assert.ok(location, 'a pin was dropped');
  close(location.lon, -22.5, 1e-6, 'corner longitude');
  close(location.lat, 21.943046, 0.001, 'corner latitude');
  assert.deepEqual(explorer.mapCenter.value, centre, 'the map did not move');
  assert.match(explorer.mapStatus.value, /Pin dropped at/);
});

test('a click is only read once the viewport has been measured', () => {
  const explorer = createMapExplorer();
  assert.equal(explorer.pickMapLocation({ clientX: 10, clientY: 10 }), false);
  assert.equal(explorer.mapPin.value, null);
});

test('dragging pans the map but does not drop a pin', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };

  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 100,
    clientY: 100,
  });
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 340, clientY: 100 });
  explorer.handleMapPointerUp({ pointerId: 1, clientX: 340, clientY: 100 });

  assert.equal(explorer.mapPin.value, null, 'a pan is not a click');
  /* 240px at zoom 4 is 240/4096 of the world, which is 21.09 degrees. */
  close(explorer.mapCenter.value.lon, (-240 / 4096) * 360, 1e-6, 'panned west');
  assert.equal(
    explorer.mapCenter.value.lat,
    0,
    'a horizontal drag keeps latitude',
  );
});

test('a drag made of many small moves is still a drag', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };

  /*
   * Twenty one-pixel steps, none of which exceeds the click threshold on its own.
   * Measuring the total travel from the press is what keeps this a pan; measuring
   * only the last step would call it a click and drop a pin at the end.
   */
  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 3,
    clientX: 200,
    clientY: 200,
  });
  for (let step = 1; step <= 20; step += 1) {
    explorer.handleMapPointerMove({
      pointerId: 3,
      clientX: 200 + step,
      clientY: 200,
    });
  }
  explorer.handleMapPointerUp({ pointerId: 3, clientX: 220, clientY: 200 });

  assert.equal(explorer.mapPin.value, null, 'a stepped drag is not a click');
  close(
    explorer.mapCenter.value.lon,
    (-20 / 4096) * 360,
    1e-6,
    'panned the total',
  );
});

test('a press and release in place drops the pin', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 10, lon: 10 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 256, height: 256 };
  explorer.mapElement.value = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };

  /* The exact centre of the viewport is the exact centre of the map. */
  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 7,
    clientX: 128,
    clientY: 128,
  });
  explorer.handleMapPointerUp({ pointerId: 7, clientX: 128, clientY: 128 });

  const pin = explorer.mapPin.value;
  assert.ok(pin, 'a pin was dropped');
  close(pin.lat, 10, 1e-6, 'pin latitude is the centre');
  close(pin.lon, 10, 1e-6, 'pin longitude is the centre');
});

test('a click inside the jitter allowance still counts as a click', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 10, lon: 10 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 256, height: 256 };
  explorer.mapElement.value = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };

  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 9,
    clientX: 128,
    clientY: 128,
  });
  explorer.handleMapPointerUp({ pointerId: 9, clientX: 131, clientY: 130 });

  assert.ok(explorer.mapPin.value, 'a three-pixel wobble is still a click');
});

test('a non-primary button starts no drag', () => {
  const explorer = createMapExplorer();
  explorer.handleMapPointerDown({
    button: 2,
    pointerId: 1,
    clientX: 5,
    clientY: 5,
  });
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 500, clientY: 500 });
  assert.deepEqual(explorer.mapCenter.value, { lat: 20, lon: 0 });
});

test('the pin offset tracks the pin as the map moves', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  explorer.mapPin.value = { lat: 0, lon: 0, label: '' };
  const centred = explorer.mapPinOffset.value;
  assert.ok(Math.abs(centred.left - 256) < 0.001, 'centred horizontally');
  assert.ok(Math.abs(centred.top - 256) < 0.001, 'centred vertically');

  /* Panning west by half a viewport puts the pin on the left edge. */
  explorer.panMapByPixels(-256, 0);
  const panned = explorer.mapPinOffset.value;
  assert.ok(Math.abs(panned.left - 0) < 0.001, 'pin moved to the left edge');
});

test('showing a stored location centres the map and zooms in', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  assert.equal(
    explorer.showMapLocation({ lat: 48.8584, lon: 2.2945, label: 'Eiffel' }),
    true,
  );
  close(explorer.mapCenter.value.lat, 48.8584, 1e-6, 'centred latitude');
  close(explorer.mapCenter.value.lon, 2.2945, 1e-6, 'centred longitude');
  assert.ok(explorer.mapZoom.value >= 13, 'zoomed to a useful street level');
  assert.equal(explorer.mapPin.value.label, 'Eiffel');
  assert.match(explorer.mapStatus.value, /Eiffel/);

  assert.equal(explorer.showMapLocation({ lat: 999, lon: 0 }), false);
  assert.equal(explorer.mapStatusError.value, true);
});

test('the badge reports the pin, then the invitation to pick one', () => {
  const explorer = createMapExplorer();
  assert.equal(explorer.mapBadge.value, 'Pick a location on the map');
  explorer.mapPin.value = { lat: 1, lon: 2, label: '' };
  assert.equal(explorer.mapBadge.value, 'Pin at 1.000000, 2.000000');
});

test('the pin is not offered when the map has never been measured', () => {
  const explorer = createMapExplorer();
  assert.deepEqual(explorer.mapTiles.value, []);
});

test('a flight interpolates the view rather than jumping it', () => {
  const { explorer, advance } = flyingExplorer();
  const from = { ...explorer.mapCenter.value, zoom: explorer.mapZoom.value };

  assert.equal(
    explorer.flyToLocation({ lat: 40, lon: 40, label: 'Far' }),
    true,
  );
  assert.equal(explorer.mapFlying.value, true);
  /* Nothing has moved yet: the first frame has not run. */
  assert.deepEqual(explorer.mapCenter.value, { lat: from.lat, lon: from.lon });

  advance(280);
  /* Halfway through a 560ms journey the view is part way there, not there. */
  const midway = explorer.mapCenter.value;
  assert.notDeepEqual(midway, { lat: from.lat, lon: from.lon }, 'it has moved');
  assert.ok(midway.lat < 40, 'but has not arrived');
  assert.ok(midway.lat > from.lat, 'and is going the right way');
  assert.ok(explorer.mapZoom.value > from.zoom, 'and it zooms on the way');

  advance(400);
  assert.equal(explorer.mapFlying.value, false, 'the journey finished');
  close(explorer.mapCenter.value.lat, 40, 1e-6, 'arrived latitude');
  close(explorer.mapCenter.value.lon, 40, 1e-6, 'arrived longitude');
  assert.equal(explorer.mapPin.value.lat, 40, 'the pin lands with the map');
});

test('a journey never zooms past the destination', () => {
  const { explorer, advance } = flyingExplorer({ initialZoom: 4 });
  explorer.flyToLocation({ lat: 10, lon: 10, label: 'Near' });
  for (let step = 0; step < 20; step += 1) advance(50);
  /* Zooming in to a place should not overshoot it on the way. */
  assert.ok(explorer.mapZoom.value <= 13 + 1e-9, 'stops at the target zoom');
  assert.ok(explorer.mapZoom.value >= 4, 'and never zooms out to get there');
});

test('a journey does not zoom out to reach a nearby place', () => {
  const { explorer, advance } = flyingExplorer({ initialZoom: 16 });
  explorer.flyToLocation({ lat: 1, lon: 1, label: 'Close' });
  for (let step = 0; step < 20; step += 1) advance(50);
  assert.equal(explorer.mapZoom.value, 16, 'stays where the reader was');
});

test('the tile set is re-committed during a journey, not magnified', () => {
  const { explorer, advance } = flyingExplorer({ initialZoom: 4 });
  explorer.flyToLocation({ lat: 30, lon: 30, label: 'Trip' });

  let worst = 0;
  for (let step = 0; step < 24; step += 1) {
    advance(40);
    /* The drawn tiles are never more than the commit threshold away from the
       view's zoom, which is what stops a zoom-in from magnifying one tile set
       sixteen times. */
    worst = Math.max(
      worst,
      Math.abs(explorer.mapZoom.value - explorer.tileZoom.value),
    );
  }
  assert.ok(
    worst <= 0.5 + 1e-9,
    `drift stayed inside the commit threshold, saw ${worst}`,
  );
});

test('the outgoing layer is kept until the incoming tiles have all arrived', () => {
  const { explorer, advance } = flyingExplorer({ initialZoom: 4 });
  explorer.flyToLocation({ lat: 20, lon: 20, label: 'Stop' });
  advance(200);

  const layer = explorer.previousLayer.value;
  assert.ok(layer, 'the ground under the journey is held');
  assert.equal(layer.tileZoom, 4, 'at the zoom it was fetched at');
  assert.ok(layer.tiles.length > 0);

  /* Its transform is live, so it tracks the animating view rather than sitting
     where it was when the journey began. Checking that it *moves with the view*
     is the property that matters; restating the formula here would only test
     that the test agrees with itself. */
  const transform = explorer.previousTransform.value;
  assert.ok(transform, 'and it is placed');
  close(
    transform.scale,
    2 ** (explorer.mapZoom.value - 4),
    1e-9,
    'scaled by the live view zoom',
  );
  const before = transform.x;
  const centreBefore = explorer.mapCenter.value.lon;
  advance(120);
  const after = explorer.previousTransform.value.x;
  assert.notEqual(after, before, 'the outgoing layer moves with the journey');
  assert.equal(
    Math.sign(after - before) ===
      Math.sign(centreBefore - explorer.mapCenter.value.lon) ||
      after === before,
    true,
    'and moves opposite the centre, as a ground layer must',
  );

  /* The first arrival is not enough to retire it. */
  const tiles = explorer.mapTiles.value;
  explorer.noteTileLoaded(tiles[0].key);
  assert.ok(explorer.previousLayer.value, 'still held after one tile');

  for (const tile of tiles) explorer.noteTileLoaded(tile.key);
  assert.equal(
    explorer.previousLayer.value,
    null,
    'retired once the set is complete',
  );
});

test('a reader grabbing the map stops the journey and keeps the pin', () => {
  const { explorer, advance } = flyingExplorer();
  explorer.flyToLocation({ lat: 40, lon: 40, label: 'Far' });
  advance(150);
  const where = { ...explorer.mapCenter.value };
  assert.equal(explorer.mapFlying.value, true);

  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
  });
  assert.equal(explorer.mapFlying.value, false, 'the journey stopped');
  assert.deepEqual(explorer.mapCenter.value, where, 'and stayed where it was');
  assert.equal(
    explorer.mapPin.value,
    null,
    'without arriving somewhere unasked',
  );

  /* And it does not resume. */
  advance(600);
  assert.equal(
    explorer.mapCenter.value.lat,
    where.lat,
    "the view is the reader's",
  );
});

test('a wheel gesture and an arrow key also stop the journey', () => {
  const wheel = flyingExplorer();
  wheel.explorer.flyToLocation({ lat: 30, lon: 30, label: 'A' });
  wheel.advance(120);
  assert.equal(wheel.explorer.mapFlying.value, true);
  wheel.explorer.handleMapWheel({ deltaY: -100, preventDefault: () => {} });
  assert.equal(wheel.explorer.mapFlying.value, false, 'the wheel took over');

  const keys = flyingExplorer();
  keys.explorer.flyToLocation({ lat: 30, lon: 30, label: 'B' });
  keys.advance(120);
  keys.explorer.handleMapKeydown({
    key: 'ArrowRight',
    preventDefault: () => {},
  });
  assert.equal(keys.explorer.mapFlying.value, false, 'a key took over');
});

test('a key the map does not use leaves the journey alone', () => {
  const { explorer, advance } = flyingExplorer();
  explorer.flyToLocation({ lat: 30, lon: 30, label: 'A' });
  advance(120);
  explorer.handleMapKeydown({ key: 'q', preventDefault: () => {} });
  assert.equal(explorer.mapFlying.value, true, 'still travelling');
});

test('a second journey replaces the first', () => {
  const { explorer, advance } = flyingExplorer();
  explorer.flyToLocation({ lat: 40, lon: 40, label: 'First' });
  advance(120);
  explorer.flyToLocation({ lat: -20, lon: -20, label: 'Second' });
  for (let step = 0; step < 20; step += 1) advance(50);
  close(explorer.mapCenter.value.lat, -20, 1e-6, 'it went to the second place');
  assert.equal(explorer.mapPin.value.label, 'Second', 'and dropped that pin');
});

test('a reduced-motion preference arrives without travelling', () => {
  const { explorer, advance } = flyingExplorer({
    doc: {
      defaultView: {
        matchMedia: (query) => ({ matches: query.includes('reduce') }),
      },
    },
  });

  assert.equal(
    explorer.flyToLocation({ lat: 40, lon: 40, label: 'Far' }),
    true,
  );

  /* No frames, no intermediate positions: the map is simply there. */
  assert.equal(explorer.mapFlying.value, false);
  close(explorer.mapCenter.value.lat, 40, 1e-6, 'arrived at once');
  assert.equal(explorer.mapPin.value.label, 'Far');
  assert.equal(advance(600), undefined);
  assert.equal(explorer.mapFlying.value, false, 'and did not start later');
});

test('a place already framed at the right zoom does not start a journey', () => {
  /* Started at 13, the level a place is looked at from, so there is nothing to
     change at all. */
  const { explorer } = flyingExplorer({ initialZoom: 13 });
  const here = {
    lat: explorer.mapCenter.value.lat,
    lon: explorer.mapCenter.value.lon,
  };

  assert.equal(explorer.flyToLocation({ ...here, label: 'Here' }), true);

  assert.equal(explorer.mapFlying.value, false, 'nothing to travel');
  assert.equal(explorer.mapPin.value.label, 'Here', 'but the pin is still set');
});

test('a place already on screen is still zoomed in to, and travels there', () => {
  const { explorer, advance } = flyingExplorer({ initialZoom: 4 });
  const here = {
    lat: explorer.mapCenter.value.lat,
    lon: explorer.mapCenter.value.lon,
  };

  assert.equal(explorer.flyToLocation({ ...here, label: 'Here' }), true);

  /* Same spot, but a continent away in scale. Zooming to it is worth animating
     too: a sudden jump from z4 to z13 is disorienting in the other direction as
     well. */
  assert.equal(explorer.mapFlying.value, true, 'it zooms in');
  for (let step = 0; step < 20; step += 1) advance(50);
  assert.equal(explorer.mapFlying.value, false);
  assert.equal(explorer.mapZoom.value, 13, 'and arrived at the useful level');
});

test('an unusable coordinate is reported and starts nothing', () => {
  const { explorer } = flyingExplorer();
  assert.equal(explorer.flyToLocation({ lat: 400, lon: 0 }), false);
  assert.equal(explorer.mapFlying.value, false);
  assert.equal(explorer.mapStatusError.value, true);
});

test('a zero-length journey is an immediate arrival', () => {
  const { explorer } = flyingExplorer();
  assert.equal(
    explorer.flyToLocation({ lat: 12, lon: 34, label: 'Now' }, { duration: 0 }),
    true,
  );
  assert.equal(explorer.mapFlying.value, false);
  close(explorer.mapCenter.value.lat, 12, 1e-6, 'arrived');
  assert.equal(explorer.mapPin.value.label, 'Now');
});

test('the status says where the map is going and then where it got to', () => {
  const { explorer, advance } = flyingExplorer();
  explorer.flyToLocation({ lat: 40, lon: 40, label: 'Eiffel Tower' });
  assert.match(explorer.mapStatus.value, /Travelling to Eiffel Tower/);
  advance(700);
  assert.match(explorer.mapStatus.value, /Eiffel Tower/);
  assert.equal(explorer.mapStatusError.value, false);
});

test('the immediate jump is still available and still sets the pin at once', () => {
  const { explorer } = flyingExplorer();
  assert.equal(
    explorer.showMapLocation({ lat: 7, lon: 8, label: 'Jump' }),
    true,
  );
  assert.equal(explorer.mapFlying.value, false, 'no journey');
  assert.equal(explorer.mapPin.value.label, 'Jump');
  close(explorer.mapCenter.value.lat, 7, 1e-6, 'arrived immediately');
  assert.equal(explorer.mapZoom.value, 13, 'and zoomed to the useful level');
});
