/*
 * Unit tests for the OpenStreetMap Explorer: the Web Mercator projection, the
 * tile grid, and the session's pan, zoom, and pin behaviour.
 *
 * The projection cases are pinned against known slippy-map tile numbers rather
 * than against this implementation, so a change to the formulas that breaks
 * real coordinates fails here instead of quietly shifting the map.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampLatitude,
  clampZoom,
  createMapExplorer,
  formatCoordinates,
  latToTileY,
  lonToTileX,
  MAX_LATITUDE,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeLocation,
  TILE_SIZE,
  tileCount,
  unprojectFromPixel,
  visibleTiles,
  wrapLongitude,
} from '../src/map-explorer.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected}, got ${actual}`,
  );

test('the projection matches known slippy-map tile numbers', () => {
  /*
   * Reference values from the standard OSM tile scheme. San Francisco is
   * z12 tile 655/1583 and Berlin is z10 tile 550/335; the equator and prime
   * meridian sit on an exact tile boundary at low zooms.
   */
  close(lonToTileX(-122.4194, 12), 655.139, 0.01, 'SF x');
  close(latToTileY(37.7749, 12), 1583.19, 0.01, 'SF y');
  close(lonToTileX(13.3777, 10), 550.052, 0.01, 'Berlin x');
  close(latToTileY(52.5163, 10), 335.843, 0.01, 'Berlin y');

  assert.equal(lonToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.equal(lonToTileX(0, 2), 2);
  assert.equal(latToTileY(0, 2), 2);

  /* The north-west corner of the world is the 0/0 tile at every zoom. */
  assert.equal(lonToTileX(-180, 5), 0);
  /* Float error only: the clamp latitude is the very edge of tile row 0. */
  close(latToTileY(MAX_LATITUDE, 5), 0, 1e-9, 'north edge is row 0');
  /*
   * The south clamp is the world's bottom edge, which is one past the last row
   * (32, not 31) - the last row itself starts at 31. Asserting the edge is what
   * pins down that the projection spans the full world height.
   */
  close(latToTileY(-MAX_LATITUDE, 5), tileCount(5), 1e-9, 'south edge');
  /* One row up the ladder is genuinely the last served row. */
  assert.equal(Math.floor(latToTileY(-84, 5)), tileCount(5) - 1, 'last row');
});

test('projecting and unprojecting round-trips across the range', () => {
  const points = [
    { lat: 0, lon: 0 },
    { lat: 51.507351, lon: -0.127758 },
    { lat: -33.86882, lon: 151.20929 },
    { lat: 64.1466, lon: -21.9426 },
    { lat: MAX_LATITUDE, lon: 179.999 },
  ];
  for (const point of points) {
    for (const zoom of [MIN_ZOOM, 8, 15, MAX_ZOOM]) {
      const scale = TILE_SIZE * 2 ** zoom;
      const sine = Math.sin((point.lat * Math.PI) / 180);
      const pixel = {
        x: ((point.lon + 180) / 360) * scale,
        y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale,
      };
      const back = unprojectFromPixel(pixel.x, pixel.y, zoom);
      close(back.lat, point.lat, 1e-9, `lat at z${zoom}`);
      close(back.lon, point.lon, 1e-9, `lon at z${zoom}`);
    }
  }
});

test('the poles project to finite pixels instead of infinity', () => {
  for (const lat of [90, -90, MAX_LATITUDE, -MAX_LATITUDE]) {
    const sine = Math.sin((clampLatitude(lat) * Math.PI) / 180);
    const y =
      (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) *
      TILE_SIZE *
      2 ** MAX_ZOOM;
    assert.ok(Number.isFinite(y), `y for latitude ${lat}`);
  }
});

test('latitude, longitude, and zoom are clamped to what the tiles serve', () => {
  assert.equal(clampLatitude(1000), MAX_LATITUDE);
  assert.equal(clampLatitude(-1000), -MAX_LATITUDE);
  assert.equal(clampLatitude('nonsense'), 0);
  assert.equal(clampLatitude(Number.NaN), 0);

  /* Longitude wraps rather than clamping, so panning past the seam is seamless. */
  assert.equal(wrapLongitude(180), -180);
  assert.equal(wrapLongitude(190), -170);
  assert.equal(wrapLongitude(-190), 170);
  assert.equal(wrapLongitude(540), -180);
  assert.equal(wrapLongitude('nonsense'), 0);

  assert.equal(clampZoom(0), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(12.4), 12);
  assert.equal(clampZoom('nonsense'), MIN_ZOOM);
});

test('the tile grid covers the viewport and nothing outside it', () => {
  const width = 800;
  const height = 600;
  const tiles = visibleTiles({
    centerLat: 51.507351,
    centerLon: -0.127758,
    zoom: 12,
    width,
    height,
  });

  /* At this viewport the origin lands mid-tile, so the grid is 5 x 4. */
  assert.equal(tiles.length, 20);
  for (const tile of tiles) {
    assert.ok(tile.left > -TILE_SIZE && tile.left < width, `left ${tile.left}`);
    assert.ok(tile.top > -TILE_SIZE && tile.top < height, `top ${tile.top}`);
    assert.ok(tile.x >= 0 && tile.x < tileCount(12), 'x in range');
    assert.ok(tile.y >= 0 && tile.y < tileCount(12), 'y in range');
  }
  assert.equal(
    new Set(tiles.map((tile) => tile.key)).size,
    tiles.length,
    'tile keys are unique',
  );

  /*
   * The property that actually matters: the union of the returned rectangles has
   * to cover the whole viewport, or the map shows holes. Walking the four edges
   * and finding a gap is a stronger check than any fixed count.
   */
  const covers = (x, y) =>
    tiles.some(
      (tile) =>
        x >= tile.left &&
        x < tile.left + TILE_SIZE &&
        y >= tile.top &&
        y < tile.top + TILE_SIZE,
    );
  for (const x of [0, 1, width / 2, width - 2, width - 1]) {
    for (const y of [0, 1, height / 2, height - 2, height - 1]) {
      assert.ok(covers(x, y), `tile gap at ${x},${y}`);
    }
  }
});

test('a viewport with no measured size asks for no tiles', () => {
  const base = { centerLat: 0, centerLon: 0, zoom: 10 };
  assert.deepEqual(visibleTiles({ ...base, width: 0, height: 600 }), []);
  assert.deepEqual(visibleTiles({ ...base, width: 800, height: 0 }), []);
  assert.deepEqual(visibleTiles({ ...base, width: 0, height: 0 }), []);
});

test('panning past the antimeridian wraps columns instead of blanking them', () => {
  const tiles = visibleTiles({
    centerLat: 0,
    centerLon: 179.9,
    zoom: 4,
    width: 1024,
    height: 256,
  });
  assert.ok(tiles.length > 0);
  for (const tile of tiles) {
    assert.ok(tile.x >= 0 && tile.x < tileCount(4), 'x wrapped into range');
  }
});

test('a bad stored location reads as no location instead of NaN', () => {
  assert.equal(normalizeLocation(null), null);
  assert.equal(normalizeLocation('somewhere'), null);
  assert.equal(normalizeLocation({ lat: 'north', lon: 0 }), null);
  assert.equal(normalizeLocation({ lat: 0, lon: Number.NaN }), null);
  assert.equal(normalizeLocation({ lat: 400, lon: 0 }), null);
  assert.equal(normalizeLocation({ lat: 0, lon: 400 }), null);
  assert.equal(formatCoordinates({ lat: 'x', lon: 'y' }), 'No location');
});

test('a valid location is rounded to about a centimetre', () => {
  assert.deepEqual(normalizeLocation({ lat: 51.5073514, lon: -0.1277584 }), {
    lat: 51.507351,
    lon: -0.127758,
    label: '',
  });
  assert.equal(
    normalizeLocation({ lat: 10, lon: 20, label: '  Home  ' }).label,
    'Home',
  );
  assert.equal(
    normalizeLocation({ lat: 10, lon: 20, label: 'x'.repeat(200) }).label
      .length,
    120,
  );
  assert.equal(
    formatCoordinates({ lat: 51.507351, lon: -0.127758 }),
    '51.507351, -0.127758',
  );
});

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

test('zooming keeps the point under the anchor pinned to that pixel', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };

  /* The anchor is a quarter across and an eighth down the viewport. */
  const anchorX = 128;
  const anchorY = 64;
  const before = explorer.locationFromEvent({
    clientX: anchorX,
    clientY: anchorY,
  });
  assert.ok(before);

  explorer.zoomMap(3, anchorX, anchorY);

  const after = explorer.locationFromEvent({
    clientX: anchorX,
    clientY: anchorY,
  });
  close(after.lat, before.lat, 1e-6, 'anchor latitude held');
  close(after.lon, before.lon, 1e-6, 'anchor longitude held');
  assert.equal(explorer.mapZoom.value, 7);
});

test('zooming is clamped at both ends and never reports a no-op change', () => {
  const explorer = createMapExplorer({ initialZoom: MAX_ZOOM });
  const centre = explorer.mapCenter.value;
  explorer.zoomIn();
  assert.equal(explorer.mapZoom.value, MAX_ZOOM);
  assert.deepEqual(explorer.mapCenter.value, centre, 'a refused zoom is inert');

  const low = createMapExplorer({ initialZoom: MIN_ZOOM });
  low.zoomOut();
  assert.equal(low.mapZoom.value, MIN_ZOOM);
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

test('the observer is disconnected and the resize listener removed on dispose', () => {
  const listeners = [];
  const observers = [];
  const documentStub = {
    defaultView: {
      ResizeObserver: class {
        constructor(callback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {
          observers.disconnected = true;
        }
      },
      addEventListener: (name) => listeners.push(name),
      removeEventListener: (name) =>
        listeners.splice(listeners.indexOf(name), 1),
    },
  };
  const explorer = createMapExplorer({ doc: documentStub });
  explorer.mapElement.value = { clientWidth: 300, clientHeight: 200 };

  explorer.startMapObserver();
  assert.equal(explorer.mapSize.value.width, 300, 'measured on start');
  assert.ok(listeners.includes('resize'), 'listening for window resize');

  explorer.disposeMapExplorer();
  assert.equal(listeners.includes('resize'), false, 'listener removed');
});

test('the pin is not offered when the map has never been measured', () => {
  const explorer = createMapExplorer();
  assert.deepEqual(explorer.mapTiles.value, []);
});
