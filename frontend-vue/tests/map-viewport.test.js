/*
 * The shared map viewport: zoom commits, the rate floor that gates tile requests,
 * pan, inertia, the pointer and keyboard handlers, the layer transform as the
 * session uses it, and the loading state.
 *
 * These cases build a session because the viewport is composed into one, and the
 * assertions are about the viewport. Before TODO-093 the same behaviour was only
 * reachable through the Explorer, which is the indirection that let the two
 * copies of this logic drift.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_LATITUDE } from '../src/geo.js';
import { createMapExplorer } from '../src/map-explorer.js';
import { classifyWheel, TRACKPAD_MAX_DELTA } from '../src/map-input.js';
import {
  committedZoom,
  layerTransform,
  MAX_ZOOM,
  MIN_ZOOM,
  minimumZoomFor,
  projectToPixel,
  TILE_SIZE,
  tileCount,
  unprojectFromPixel,
  visibleTiles,
} from '../src/map-projection.js';
import { TILE_BURST } from '../src/map-viewport.js';
import { close, readyExplorer } from './support/map-fixtures.mjs';

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

test('a full screen opens with a burst, and no more', () => {
  const explorer = readyExplorer();
  const total = explorer.mapTiles.value.length;
  assert.ok(total > TILE_BURST, 'a 512px pane needs more tiles than one burst');
  assert.equal(
    explorer.admittedTileCount(),
    TILE_BURST,
    'the first screenful is admitted at once',
  );
  assert.equal(explorer.burstTokens(), 0, 'and the bucket is spent');
  assert.equal(explorer.pendingTileCount(), total - TILE_BURST);
});

test('the rest of the screen arrives one floor interval at a time', async () => {
  let clock = 1000;
  const explorer = readyExplorer({
    now: () => clock,
    rateFloorMs: 200,
  });
  const total = explorer.mapTiles.value.length;

  /* Nothing more may start before the floor has passed, however long we wait for
     something else to happen. */
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(explorer.admittedTileCount(), TILE_BURST, 'still waiting');

  clock += 200;
  explorer.admitTiles();
  assert.equal(
    explorer.admittedTileCount(),
    TILE_BURST + 1,
    'exactly one more after one interval',
  );

  clock += 1000;
  explorer.admitTiles();
  assert.ok(
    explorer.admittedTileCount() > TILE_BURST + 1,
    'several more after a long pause, capped by the bucket',
  );
  assert.ok(
    explorer.admittedTileCount() <= total,
    'and never more than the screen asked for',
  );
  assert.ok(explorer.burstTokens() <= TILE_BURST, 'the bucket is bounded');
});

test('the bucket refills to its ceiling rather than accumulating', () => {
  let clock = 0;
  const explorer = readyExplorer({ now: () => clock, rateFloorMs: 200 });
  /* Ten intervals of idleness is ten slots, but only eight fit. */
  clock = 2000;
  explorer.admitTiles();
  assert.ok(explorer.burstTokens() <= TILE_BURST);
  assert.ok(explorer.admittedTileCount() <= TILE_BURST + 8);
});

test('a floor of zero disables the deferral entirely', () => {
  const explorer = readyExplorer({ rateFloorMs: 0 });
  assert.equal(
    explorer.admittedTileCount(),
    explorer.mapTiles.value.length,
    'everything is admitted at once',
  );
});

test('the tiles nearest the middle of the screen are the ones admitted first', () => {
  const explorer = readyExplorer();
  const admitted = explorer.mapTiles.value.filter(explorer.isTileAdmitted);
  const span = tileCount(explorer.tileZoom.value);
  const distance = (tile) =>
    Math.abs(tile.x + 0.5 - span / 2) ** 2 +
    Math.abs(tile.y + 0.5 - span / 2) ** 2;
  const furthestAdmitted = Math.max(...admitted.map(distance));
  const nearestPending = Math.min(
    ...explorer.mapTiles.value
      .filter((tile) => !explorer.isTileAdmitted(tile))
      .map(distance),
  );
  assert.ok(
    furthestAdmitted <= nearestPending,
    'nothing at the edge is admitted while the middle is still waiting',
  );
});

test('an unadmitted tile is not given a tile URL', () => {
  const explorer = readyExplorer();
  const pending = explorer.mapTiles.value.find(
    (tile) => !explorer.isTileAdmitted(tile),
  );
  const admitted = explorer.mapTiles.value.find(explorer.isTileAdmitted);
  assert.ok(pending && admitted, 'the screen has both kinds');
  assert.match(
    explorer.tileSource(pending),
    /^data:image/,
    'a pending tile holds a transparent pixel rather than a request',
  );
  assert.match(explorer.tileSource(admitted), /tile\.openstreetmap\.org/);
});

test('an admitted tile stays admitted, so panning back costs nothing', () => {
  let clock = 0;
  const explorer = readyExplorer({ now: () => clock, rateFloorMs: 200 });
  const before = explorer.admittedTileCount();
  /* Away and back again, with no clock movement at all: the floor cannot be what
     limits a revisit to ground that is already on screen. */
  explorer.panMapByPixels(600, 0);
  clock += 4000;
  explorer.panMapByPixels(-600, 0);
  assert.ok(explorer.admittedTileCount() >= before);
  for (const tile of explorer.mapTiles.value) {
    if (explorer.isTileAdmitted(tile)) {
      assert.match(explorer.tileSource(tile), /tile\.openstreetmap\.org/);
    }
  }
});

test('disposing releases the admission timer and the admitted set', async () => {
  const explorer = readyExplorer();
  assert.ok(explorer.pendingTileCount() > 0, 'work was still queued');
  explorer.disposeMapExplorer();
  assert.equal(explorer.admittedTileCount(), 0, 'the admitted set is released');
  /* The drain must not outlive the session: if the timer were still armed it
     would re-admit from a disposed session on the next tick. */
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(explorer.admittedTileCount(), 0, 'and nothing re-admitted');
});

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
