/*
 * Unit tests for the OpenStreetMap Explorer.
 *
 * The projection and layout cases are pinned against known slippy-map tile
 * numbers rather than against this implementation, so a change to the formulas
 * that breaks real coordinates fails here instead of quietly shifting the map.
 * The projection and gesture-intent cases need no session and live alongside
 * the pure modules they exercise; the rest drive createMapExplorer().
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampLatitude,
  formatCoordinates,
  MAX_LATITUDE,
  normalizeLocation,
  wrapLongitude,
} from '../src/geo.js';
import { createMapExplorer } from '../src/map-explorer.js';
import { classifyWheel, TRACKPAD_MAX_DELTA } from '../src/map-input.js';
import {
  clampZoom,
  committedZoom,
  latToTileY,
  layerTransform,
  lonToTileX,
  MAX_ZOOM,
  MIN_ZOOM,
  metersPerPixel,
  minimumZoomFor,
  projectToPixel,
  scaleBarFor,
  TILE_SIZE,
  tileCount,
  unprojectFromPixel,
  visibleTiles,
} from '../src/map-projection.js';

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
  assert.equal(clampZoom('nonsense'), MIN_ZOOM);
  /*
   * Zoom is deliberately fractional - that is what makes a pinch continuous -
   * so clamping preserves the fraction and only the tile level is rounded.
   */
  assert.equal(clampZoom(12.4), 12.4);
  assert.equal(committedZoom(12.4), 12);
  assert.equal(committedZoom(12.6), 13);
  assert.equal(committedZoom(0.2), MIN_ZOOM);
});

test('a prefetch ring is always requested beyond the viewport', () => {
  const base = {
    centerLat: 51.507351,
    centerLon: -0.127758,
    zoom: 12,
    width: 800,
    height: 600,
  };
  const bare = visibleTiles({ ...base, buffer: 0 });
  const buffered = visibleTiles({ ...base, buffer: 1 });

  assert.ok(buffered.length > bare.length, 'a buffer adds tiles');
  /* A one-tile buffer extends the grid by exactly one ring on every side, so
     every tile the viewport needs is still present. */
  for (const tile of bare) {
    assert.ok(
      buffered.some((candidate) => candidate.key === tile.key),
      `buffered set dropped ${tile.key}`,
    );
  }
  /* And it reaches at least a tile further out on every edge. */
  const reach = (tiles, axis) =>
    Math.max(...tiles.map((tile) => (axis === 'x' ? tile.left : tile.top))) -
    Math.min(...tiles.map((tile) => (axis === 'x' ? tile.left : tile.top)));
  assert.ok(reach(buffered, 'x') >= reach(bare, 'x') + 2 * TILE_SIZE - 1);
  assert.ok(reach(buffered, 'y') >= reach(bare, 'y') + 2 * TILE_SIZE - 1);
});

test('the tile set only changes when a tile line is crossed', () => {
  const base = {
    centerLat: 0,
    centerLon: 0,
    zoom: 4,
    width: 800,
    height: 600,
    buffer: 1,
  };
  const at = (x) => visibleTiles({ ...base, centerLon: x });
  const a = at(0);
  /* A few pixels of pan must not re-key the set, or Vue churns tiles mid-drag. */
  assert.deepEqual(
    at(0.0001).map((t) => t.key),
    a.map((t) => t.key),
  );
  /* 0.5 degrees at zoom 4 is under six pixels, still inside one tile. */
  assert.deepEqual(
    at(0.5).map((t) => t.key),
    a.map((t) => t.key),
  );
  /* One tile line at zoom 4 is 22.5 degrees of longitude. */
  assert.notDeepEqual(
    at(25).map((t) => t.key),
    a.map((t) => t.key),
  );
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
    buffer: 0,
  });

  /* At this viewport the origin lands mid-tile, so the grid is 5 x 4. */
  assert.equal(tiles.length, 20);
  /* Positions are absolute world pixels on tile lines, so a tile never moves
     when the view does; the layer transform is what places them. */
  for (const tile of tiles) {
    assert.equal(tile.left % TILE_SIZE, 0, 'x lands on a tile line');
    assert.equal(tile.top % TILE_SIZE, 0, 'y lands on a tile line');
    assert.ok(tile.x >= 0 && tile.x < tileCount(12), 'x in range');
    assert.ok(tile.y >= 0 && tile.y < tileCount(12), 'y in range');
  }
  assert.equal(
    new Set(tiles.map((tile) => tile.key)).size,
    tiles.length,
    'tile keys are unique',
  );

  /*
   * The property that actually matters: once the layer transform is applied, the
   * tiles must cover every pixel of the viewport, or the map shows holes. This
   * exercises the grid and the transform together, which is how they are used.
   */
  const transform = layerTransform({
    centerLat: 51.507351,
    centerLon: -0.127758,
    zoom: 12,
    tileZoom: 12,
    width,
    height,
  });
  assert.equal(
    transform.scale,
    1,
    'no scale when the view is at the tile zoom',
  );
  const covers = (x, y) =>
    tiles.some((tile) => {
      const left = tile.left * transform.scale + transform.x;
      const top = tile.top * transform.scale + transform.y;
      return (
        x >= left && x < left + TILE_SIZE && y >= top && y < top + TILE_SIZE
      );
    });
  for (const x of [0, 1, width / 2, width - 2, width - 1]) {
    for (const y of [0, 1, height / 2, height - 2, height - 1]) {
      assert.ok(covers(x, y), `tile gap at ${x},${y}`);
    }
  }
});

test('a viewport with no measured size asks for no tiles', () => {
  const base = { centerLat: 0, centerLon: 0, zoom: 10, buffer: 0 };
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
    buffer: 0,
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

/* A session with a measured viewport and a stubbed element box. */
function readyExplorer(options = {}) {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    ...options,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    clientWidth: 512,
    clientHeight: 512,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  return explorer;
}

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

/* --- the layer transform --------------------------------------------------- */

/*
 * The transform is the whole map: one expression places every tile. These cases
 * pin the two things it must get right - the centre stays at the middle of the
 * viewport, and a fractional zoom scales about that same point.
 */
test('the transform keeps the centre at the middle of the viewport', () => {
  const width = 800;
  const height = 600;
  for (const [lat, lon, zoom] of [
    [0, 0, 4],
    [51.507351, -0.127758, 12],
    [-33.86882, 151.20929, 9],
    [64.1466, -21.9426, 17],
  ]) {
    const transform = layerTransform({
      centerLat: lat,
      centerLon: lon,
      zoom,
      tileZoom: zoom,
      width,
      height,
    });
    assert.equal(transform.scale, 1);
    /* The view's own centre, expressed in tile pixels and placed by the
       transform, must land at half the viewport. */
    const center = projectToPixel(lon, lat, zoom);
    close(
      center.x * transform.scale + transform.x,
      width / 2,
      1e-6,
      'x centred',
    );
    close(
      center.y * transform.scale + transform.y,
      height / 2,
      1e-6,
      'y centred',
    );
  }
});

test('a fractional zoom scales the committed tile set about the centre', () => {
  const base = { centerLat: 0, centerLon: 0, width: 800, height: 600 };
  const at = (zoom, tileZoom = 4) =>
    layerTransform({ ...base, zoom, tileZoom });

  /* Zooming in past the committed level magnifies the tiles already drawn,
     which is what makes a pinch continuous. */
  const closer = at(4.25);
  assert.ok(closer.scale > 1, 'zooming in magnifies');
  close(closer.scale, 2 ** 0.25, 1e-9, 'by the zoom difference');
  /*
   * The centre must stay the middle of the viewport *after* scaling. A tile's
   * position is in tile-zoom pixels, so the centre is expressed at the tile zoom
   * too and placed as position * scale + translate. The translate is
   * deliberately not scaled, and this is the case that catches one that is.
   */
  const centre = projectToPixel(0, 0, 4);
  close(centre.x * closer.scale + closer.x, 400, 1e-6, 'still centred');
  close(
    centre.y * closer.scale + closer.y,
    300,
    1e-6,
    'still centred vertically',
  );

  /* Zooming out below the committed level shrinks them instead. */
  assert.ok(at(3.75).scale < 1, 'zooming out shrinks');

  /* Once the two agree the scale is exactly 1, which is why committing the tile
     set at the nearest level does not shift anything. */
  assert.equal(at(4, 4).scale, 1);
});

test('the transform is one composited translate plus a scale', () => {
  const transform = layerTransform({
    centerLat: 0,
    centerLon: 0,
    zoom: 4.5,
    tileZoom: 4,
    width: 800,
    height: 600,
  });
  assert.match(
    transform.css,
    /^translate3d\(-?[\d.]+px, -?[\d.]+px, 0\) scale\([\d.]+\)$/,
  );
});

/* --- wheel intent ---------------------------------------------------------- */

test('a pinch and a mouse notch zoom, a trackpad scroll pans', () => {
  /* A trackpad pinch arrives as ctrl+wheel, whatever the delta. */
  assert.equal(classifyWheel({ deltaY: -2, ctrlKey: true }), 'zoom');
  assert.equal(classifyWheel({ deltaY: 2, ctrlKey: true }), 'zoom');
  /* A notched wheel sends large pixel deltas, or line steps. */
  assert.equal(classifyWheel({ deltaY: -100 }), 'zoom');
  assert.equal(classifyWheel({ deltaY: 100 }), 'zoom');
  assert.equal(classifyWheel({ deltaY: -3, deltaMode: 1 }), 'zoom');
  /* A trackpad's two-finger scroll is small and pixel-valued: it must pan, or
     the map zooms on every flick and cannot be panned at all. */
  assert.equal(classifyWheel({ deltaY: -4 }), 'pan');
  assert.equal(classifyWheel({ deltaY: 12 }), 'pan');
  /* Exactly at the threshold is treated as a notch, so a slow scroll does not
     creep. */
  assert.equal(classifyWheel({ deltaY: -TRACKPAD_MAX_DELTA }), 'zoom');
  assert.equal(classifyWheel({ deltaY: -(TRACKPAD_MAX_DELTA - 1) }), 'pan');
  /* Shift is the conventional horizontal-pan modifier. */
  assert.equal(classifyWheel({ deltaY: -4, shiftKey: true }), 'pan');
  assert.equal(classifyWheel({ deltaY: -100, shiftKey: true }), 'pan');
});

test('the session pans on a trackpad scroll and zooms on a notch', () => {
  const explorer = readyExplorer();
  const before = explorer.mapCenter.value;

  explorer.handleMapWheel({ deltaY: 8, deltaX: 0, preventDefault: () => {} });
  assert.notDeepEqual(explorer.mapCenter.value, before, 'a scroll pans');
  assert.equal(explorer.mapZoom.value, 4, 'a scroll does not zoom');

  const panned = explorer.mapCenter.value;
  explorer.handleMapWheel({
    deltaY: -100,
    ctrlKey: false,
    preventDefault: () => {},
  });
  assert.equal(explorer.mapZoom.value, 5, 'a notch zooms');
  assert.notDeepEqual(
    explorer.mapCenter.value,
    panned,
    'zooming keeps the anchor',
  );
});

test('a pinch moves the zoom in fractions and commits on settle', async () => {
  const explorer = readyExplorer();

  /* Several small pinch deltas: the zoom moves fractionally and the drawn tile
     set does not change, so no new tiles are fetched mid-gesture. */
  for (let step = 0; step < 5; step += 1) {
    explorer.handleMapWheel({
      deltaY: -6,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
      preventDefault: () => {},
    });
  }
  assert.ok(explorer.mapZoom.value > 4, 'zoom increased');
  assert.ok(explorer.mapZoom.value < 5, 'but not by a whole level yet');
  assert.equal(
    explorer.tileZoom.value,
    4,
    'the tile set has not been re-fetched',
  );

  /* Committing re-bases the drawn set on the nearest whole level. The view keeps
     its fractional zoom - only the tiles snap to an integer, because only integer
     levels have tiles. */
  explorer.commitTileZoom();
  assert.equal(explorer.tileZoom.value, committedZoom(explorer.mapZoom.value));
  close(explorer.mapZoom.value, 4.125, 1e-9, 'the view stayed fractional');
  close(
    explorer.mapTransform.value.scale,
    2 ** 0.125,
    1e-9,
    'tiles scaled to match',
  );
});

test('a large pinch step still does not thrash the tile set', () => {
  const explorer = readyExplorer();
  const before = explorer.tileZoom.value;

  /* Ten small deltas that add up to more than the commit threshold. */
  for (let step = 0; step < 10; step += 1) {
    explorer.handleMapWheel({
      deltaY: -40,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
      preventDefault: () => {},
    });
  }
  /* It may have re-committed, but only to whole levels - never a fractional
     tile zoom, which has no tiles to serve. */
  assert.equal(explorer.tileZoom.value, Math.round(explorer.tileZoom.value));
  assert.ok(explorer.tileZoom.value > before, 'it did eventually zoom in');
});

/* --- inertia, double click, keyboard ---------------------------------------- */

test('a flick glides and then stops, without dropping a pin', () => {
  let clock = 0;
  const frames = [];
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    now: () => clock,
    animate: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelFrame: () => {},
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
    clientX: 300,
    clientY: 300,
  });
  /* Two fast moves, then release. */
  clock = 8;
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 260, clientY: 300 });
  clock = 16;
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 220, clientY: 300 });
  const dragged = explorer.mapCenter.value;
  explorer.handleMapPointerUp({ pointerId: 1, clientX: 220, clientY: 300 });

  assert.equal(explorer.mapPin.value, null, 'a flick does not drop a pin');
  assert.ok(frames.length > 0, 'a glide was scheduled');

  const started = explorer.mapCenter.value;
  clock = 48;
  frames.shift()();
  assert.notDeepEqual(explorer.mapCenter.value, started, 'the map kept moving');
  /* It coasts further in the same direction as the drag, not backwards. */
  assert.ok(explorer.mapCenter.value.lon > dragged.lon, 'glided east');
});

test('a slow drag does not glide', () => {
  let clock = 0;
  const frames = [];
  const explorer = createMapExplorer({
    now: () => clock,
    animate: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelFrame: () => {},
  });
  explorer.mapElement.value = {
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
  explorer.handleMapPointerDown({
    button: 0,
    pointerId: 1,
    clientX: 300,
    clientY: 300,
  });
  /* A long pause between press and move: the flick has already died. */
  clock = 400;
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 299, clientY: 300 });
  clock = 800;
  explorer.handleMapPointerMove({ pointerId: 1, clientX: 298, clientY: 300 });
  explorer.handleMapPointerUp({ pointerId: 1, clientX: 298, clientY: 300 });
  assert.equal(frames.length, 0, 'no glide for a slow drag');
});

test('double click zooms in about the click', () => {
  const explorer = readyExplorer();
  const before = explorer.mapZoom.value;

  explorer.handleMapDoubleClick({
    clientX: 100,
    clientY: 100,
    preventDefault: () => {},
  });

  assert.equal(explorer.mapZoom.value, before + 1);
  /* The clicked point stays where it was on screen. */
  const after = explorer.locationFromEvent({ clientX: 100, clientY: 100 });
  const anchor = unprojectFromPixel(
    projectToPixel(0, 0, before).x - 256 + 100,
    projectToPixel(0, 0, before).y - 256 + 100,
    before,
  );
  close(after.lat, anchor.lat, 1e-6, 'latitude held');
  close(after.lon, anchor.lon, 1e-6, 'longitude held');
});

test('the keyboard pans, zooms, and reports where it landed', () => {
  const explorer = readyExplorer();
  const start = { ...explorer.mapCenter.value };

  /* Pressing Right moves the view east, so the centre moves east. (A drag is the
     opposite: grabbing the map and pulling it right reveals the west.) */
  explorer.handleMapKeydown({ key: 'ArrowRight', preventDefault: () => {} });
  assert.ok(explorer.mapCenter.value.lon > start.lon, 'right moves east');

  explorer.handleMapKeydown({ key: 'ArrowUp', preventDefault: () => {} });
  assert.ok(explorer.mapCenter.value.lat > start.lat, 'up moves north');

  const zoomed = explorer.mapZoom.value;
  explorer.handleMapKeydown({ key: '+', preventDefault: () => {} });
  assert.equal(explorer.mapZoom.value, zoomed + 1);
  explorer.handleMapKeydown({ key: '-', preventDefault: () => {} });
  assert.equal(explorer.mapZoom.value, zoomed);

  /* Shift is the long step. */
  const before = explorer.mapCenter.value.lon;
  explorer.handleMapKeydown({
    key: 'ArrowRight',
    shiftKey: true,
    preventDefault: () => {},
  });
  const short = explorer.mapCenter.value.lon;
  explorer.handleMapKeydown({ key: 'ArrowLeft', preventDefault: () => {} });
  explorer.handleMapKeydown({
    key: 'ArrowLeft',
    shiftKey: true,
    preventDefault: () => {},
  });
  assert.ok(
    before - short < short - explorer.mapCenter.value.lon,
    'shift steps further',
  );

  /* A key the map does not use is left alone. */
  const beforeTyping = explorer.mapZoom.value;
  explorer.handleMapKeydown({ key: 'q', preventDefault: () => {} });
  assert.equal(explorer.mapZoom.value, beforeTyping);
  assert.match(explorer.mapStatus.value, /Centre/);
});

/* --- scale bar ------------------------------------------------------------- */

test('the resolution halves with every zoom level', () => {
  const equator = metersPerPixel(0, 10);
  close(metersPerPixel(0, 11), equator / 2, 1e-12, 'one level is half');
  /* Mercator stretches land toward the poles, so a pixel covers less ground
     there: the resolution is finest at high latitude and coarsest at the equator. */
  assert.ok(
    metersPerPixel(60, 10) < equator,
    'finer ground resolution up north',
  );
  close(metersPerPixel(60, 10), equator / 2, 1e-9, 'cos(60) is a half');
  /* The equator at the minimum zoom: zoom 0 is below MIN_ZOOM and unreachable,
     so the reference is halved by the clamp. */
  close(
    metersPerPixel(0, MIN_ZOOM),
    156543.03392 / 2 ** MIN_ZOOM,
    0.01,
    'equator at the lowest zoom',
  );
});

test('the scale bar picks a round distance that fits', () => {
  for (const [lat, zoom] of [
    [0, 4],
    [51.5, 12],
    [51.5, 15],
    [-33.9, 10],
  ]) {
    const bar = scaleBarFor(lat, zoom, 120);
    assert.ok(bar.pixels > 0, 'a distance was chosen');
    assert.ok(bar.pixels <= 120.5, `fits the allowance at z${zoom}`);
    assert.ok(bar.pixels >= 40, 'and is not a sliver');
    /* Round numbers only: 1, 2 or 5 times a power of ten. */
    const mantissa = bar.meters / 10 ** Math.floor(Math.log10(bar.meters));
    assert.ok(
      [1, 2, 5, 10].some((step) => Math.abs(mantissa - step) < 1e-6),
      `mantissa ${mantissa} is not round`,
    );
    assert.ok(bar.label.length > 0 && bar.imperial.length > 0, 'both labels');
  }
  /* At zoom 4 a pixel is nearly 10 km, so 120px is about 1000 km. */
  assert.equal(scaleBarFor(0, 4, 120).label, '1000 km');
  assert.match(scaleBarFor(51.5, 15, 120).label, /^[0-9.]+ (m|km)$/);
  /* Degenerate inputs do not divide by zero. */
  assert.equal(scaleBarFor(0, 4, 0).pixels, 0);
});

/* --- loading state ---------------------------------------------------------- */

test('tiles report in, and the loading flag clears when the set is complete', () => {
  const explorer = readyExplorer();
  const tiles = explorer.mapTiles.value;
  assert.ok(tiles.length > 0, 'tiles were requested');
  assert.equal(
    explorer.mapLoading.value,
    true,
    'loading while none have landed',
  );

  for (const tile of tiles) explorer.noteTileLoaded(tile.key);
  assert.equal(
    explorer.mapLoading.value,
    false,
    'not loading once they all land',
  );

  /* A repeat report for the same tile is not counted twice. */
  explorer.noteTileLoaded(tiles[0].key);
  assert.equal(explorer.mapLoading.value, false);
});

/* --- staying inside the world ---------------------------------------------- */

test('the zoom floor rises with the viewport so the world always covers it', () => {
  /* Zoom 0 is a 256-pixel world; a 900-pixel pane would have no tiles for most
     of its width, so the floor has to be higher than the module minimum. */
  assert.equal(minimumZoomFor(0, 0), MIN_ZOOM, 'unmeasured falls back');
  assert.equal(
    minimumZoomFor(200, 200),
    MIN_ZOOM,
    'a small pane is fine at the floor',
  );
  assert.equal(
    minimumZoomFor(900, 640),
    2,
    '900px needs zoom 2 (1024px world)',
  );
  assert.equal(minimumZoomFor(1920, 1000), 3, '1920px needs zoom 3');
  assert.equal(minimumZoomFor(99999, 100), 9, 'a 100k-pixel pane needs zoom 9');
  assert.equal(
    minimumZoomFor(1e12, 1e12),
    MAX_ZOOM,
    'clamped to the maximum a pane could ever want',
  );
  /* The world at the floor must be at least as wide as the pane. */
  for (const width of [300, 800, 1400, 2400]) {
    assert.ok(
      TILE_SIZE * 2 ** minimumZoomFor(width, 400) >= width,
      `world covers ${width}px`,
    );
  }
});

test('a session cannot zoom out past what its viewport can cover', () => {
  const explorer = readyExplorer();
  const floor = explorer.minViewZoom.value;
  for (let step = 0; step < 60; step += 1) zoomOutOf(explorer);
  assert.equal(explorer.mapZoom.value, floor, 'stopped at the floor');

  function zoomOutOf(target) {
    target.zoomMap(-0.5);
  }
});

test('panning near a pole is pulled back inside the world', () => {
  const explorer = readyExplorer({
    initialCenter: { lat: 84, lon: 0 },
    initialZoom: 12,
  });

  /* Shove it hard toward the top of the world, where no tile rows exist. */
  for (let step = 0; step < 40; step += 1) explorer.panMapByPixels(0, -400);

  const world = TILE_SIZE * 2 ** explorer.mapZoom.value;
  const center = projectToPixel(
    0,
    explorer.mapCenter.value.lat,
    explorer.mapZoom.value,
  );
  /* The viewport's top edge must not be above the world, and its bottom must not
     be below it: otherwise the pane shows bare background. */
  assert.ok(center.y - 256 >= -0.5, 'not above the top edge');
  assert.ok(center.y + 256 <= world + 0.5, 'not below the bottom edge');
  assert.ok(
    explorer.mapCenter.value.lat <= MAX_LATITUDE,
    'latitude is representable',
  );
});

test('a viewport taller than the world is centred on it, not clamped to an edge', () => {
  /* At the minimum zoom the world can be shorter than the pane. */
  const explorer = readyExplorer({ initialZoom: MIN_ZOOM });
  for (let step = 0; step < 30; step += 1) explorer.panMapByPixels(0, 400);
  const world = TILE_SIZE * 2 ** explorer.mapZoom.value;
  const center = projectToPixel(
    0,
    explorer.mapCenter.value.lat,
    explorer.mapZoom.value,
  );
  close(center.y, world / 2, 0.5, 'centred vertically');
});

/* --- travelling between saved places ---------------------------------------- */

/*
 * A session with a clock and a frame queue under the test's control, so a
 * 560ms journey can be stepped through a frame at a time instead of waited on.
 */
function flyingExplorer(options = {}) {
  let clock = 0;
  const frames = [];
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    now: () => clock,
    animate: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelFrame: () => {},
    ...options,
  });
  explorer.mapSize.value = { width: 400, height: 300 };
  explorer.mapElement.value = {
    clientWidth: 400,
    clientHeight: 300,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  /* Advances the clock and runs every frame the session asked for, including
     frames queued while stepping. */
  const advance = (ms) => {
    clock += ms;
    let guard = 0;
    while (frames.length > 0 && guard < 200) {
      frames.shift()();
      guard += 1;
    }
  };
  return { explorer, advance, frames };
}

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
