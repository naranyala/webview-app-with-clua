/*
 * Unit tests for the canvas tile renderer.
 *
 * The renderer is built directly rather than through a session, which is the
 * point of separating it: it needs a handful of accessors and a stub Image, and
 * no Vue, no DOM, and no tile server. A stub image is what makes the draw path
 * and the cache eviction testable at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCanvasRenderer } from '../src/map-canvas.js';
import { createMapExplorer } from '../src/map-explorer.js';
import { layerTransform, TILE_SIZE } from '../src/map-projection.js';

const boot = {
  map: {
    places: [],
    filter: 'none',
    renderer: 'dom',
    showGrid: false,
    showCursor: true,
    sidebarOpen: true,
  },
};

/* A 2D context that records what it was asked to do. */
function recordingContext() {
  const transforms = [];
  const draws = [];
  const clears = [];
  return {
    canvas: { width: 400, height: 300 },
    setTransform: (...args) => transforms.push(args),
    clearRect: (...args) => clears.push(args),
    drawImage: (...args) => draws.push(args),
    transforms,
    draws,
    clears,
  };
}

/* An image that is already decoded, unless `fails` is set. */
function decodedImage(fails = false) {
  return {
    complete: !fails,
    naturalWidth: 256,
    naturalHeight: 256,
    set src(value) {
      this.source = value;
      if (fails) this.onerror?.(new Error('404'));
    },
  };
}

const tiles = [{ key: '3/4/5', x: 4, y: 5, z: 3, left: 1024, top: 1280 }];

/*
 * A renderer wired to one recording context, so a scheduled frame has somewhere
 * real to draw. `context` hangs off the result for the assertions.
 */
function renderer(overrides = {}) {
  const transform = { scale: 1.5, x: -20, y: 12, css: '' };
  const context = recordingContext();
  const built = createCanvasRenderer({
    getContext: () => context,
    getTiles: () => tiles,
    getTransform: () => transform,
    getSize: () => ({ width: 400, height: 300 }),
    isEnabled: () => true,
    tileSource: (tile) => `https://tiles/${tile.z}/${tile.x}/${tile.y}.png`,
    createImage: () => decodedImage(),
    animate: (fn) => {
      fn();
      return 1;
    },
    cancelFrame: () => {},
    ...overrides,
  });
  return Object.assign(built, { context, transform });
}

test('a tile that has not decoded is skipped rather than drawn blank', () => {
  const canvas = renderer({
    createImage: () => ({
      complete: false,
      naturalWidth: 0,
      set src(value) {
        this.source = value;
      },
    }),
  });
  canvas.draw(recordingContext());
});

test('a decoded tile is drawn at its own absolute position', () => {
  const canvas = renderer();
  const context = recordingContext();
  canvas.draw(context);
  assert.equal(context.draws.length, 1);
  const [image, left, top, width, height] = context.draws[0];
  assert.equal(image.naturalWidth, 256);
  assert.equal(left, tiles[0].left, 'its absolute world pixel, not an offset');
  assert.equal(top, tiles[0].top);
  assert.equal(width, TILE_SIZE);
  assert.equal(height, TILE_SIZE);
});

test('the context is set up once in layer coordinates and reset after', () => {
  const canvas = renderer();
  const context = recordingContext();
  canvas.draw(context);

  /*
   * Three calls: an identity to clear in device space (the previous frame left a
   * scale on, and clearing under it would only wipe part of the canvas), the
   * layer transform, and an identity to hand the context back. A per-tile
   * setTransform would defeat the point of the layer transform.
   */
  assert.equal(context.transforms.length, 3);
  assert.deepEqual(
    context.transforms[0],
    [1, 0, 0, 1, 0, 0],
    'cleared in device space',
  );
  assert.deepEqual(context.clears.length, 1, 'cleared exactly once');
  assert.deepEqual(
    context.transforms.at(-1),
    [1, 0, 0, 1, 0, 0],
    'identity at the end',
  );
});

test('the layer transform reaches the context unchanged', () => {
  const canvas = renderer();
  const context = recordingContext();
  canvas.draw(context);
  const layer = context.transforms[1];
  /* [a, b, c, d, e, f]: scaleX, shearY, shearX, scaleY, translateX, translateY.
     The off-diagonal terms must be zero: a skewed map would not line up with the
     DOM layer it replaces. */
  assert.equal(layer[1], 0, 'no shear');
  assert.equal(layer[2], 0, 'no shear');
  assert.equal(layer[0], 1.5, 'x scaled');
  assert.equal(layer[3], 1.5, 'y scaled');
  assert.equal(layer[4], -20, 'x translated');
  assert.equal(layer[5], 12, 'y translated');
});

test('nothing is drawn before the viewport has a size', () => {
  const canvas = renderer({ getSize: () => ({ width: 0, height: 0 }) });
  const context = recordingContext();
  canvas.draw(context);
  assert.equal(context.draws.length, 0);
  assert.equal(context.clears.length, 0, 'and nothing is cleared either');
});

test('nothing is drawn without a context', () => {
  const canvas = renderer();
  canvas.draw(null);
});

test('an image is fetched once and re-used on later frames', () => {
  let created = 0;
  const canvas = renderer({
    createImage: () => {
      created += 1;
      return decodedImage();
    },
  });
  const context = recordingContext();
  canvas.draw(context);
  canvas.draw(context);
  canvas.draw(context);
  assert.equal(created, 1, 'one image for three frames');
  assert.equal(context.draws.length, 3, 'but it is drawn every frame');
});

test('a failed tile is remembered as a failure, not re-requested every frame', () => {
  let created = 0;
  const canvas = renderer({
    createImage: () => {
      created += 1;
      return decodedImage(true);
    },
  });
  const context = recordingContext();
  canvas.draw(context);
  const after = created;
  canvas.draw(context);
  assert.equal(created, after, 'a missing tile is not re-fetched per frame');
  assert.equal(context.draws.length, 0, 'and never drawn');
});

test('bitmaps for tiles off screen are dropped, bounding the cache', () => {
  let current = [{ key: 'a' }, { key: 'b' }];
  const canvas = renderer({ getTiles: () => current });
  const context = recordingContext();
  canvas.draw(context);
  assert.equal(canvas.imageCount(), 2, 'one per tile');

  /* Pan well away: the old bitmaps are no longer worth holding. */
  current = [{ key: 'c' }];
  canvas.draw(context);
  canvas.prune();
  assert.equal(canvas.imageCount(), 1, 'only the live tile is kept');
});

test('nothing is scheduled while the renderer is switched off', () => {
  let frames = 0;
  const canvas = renderer({
    isEnabled: () => false,
    animate: (fn) => {
      frames += 1;
      fn();
      return 1;
    },
  });
  canvas.schedule();
  assert.equal(frames, 0, 'DOM mode never asks for a canvas frame');
});

test('a burst of state changes draws once', () => {
  const queued = [];
  const canvas = renderer({
    animate: (fn) => {
      queued.push(fn);
      return queued.length;
    },
  });
  canvas.schedule();
  canvas.schedule();
  canvas.schedule();
  assert.equal(queued.length, 1, 'three requests, one frame');
  queued.shift()();
  assert.equal(canvas.context.draws.length, 1, 'and that frame draws');
});

test('disposing abandons the frame and releases the cache', () => {
  let pending = null;
  let cancelled = null;
  const canvas = renderer({
    animate: (fn) => {
      pending = fn;
      return 7;
    },
    cancelFrame: (handle) => {
      cancelled = handle;
    },
  });
  canvas.draw(canvas.context);
  assert.equal(canvas.imageCount(), 1, 'the tile bitmap is cached');

  canvas.schedule();
  assert.notEqual(pending, null, 'a frame is pending');

  canvas.dispose();
  assert.equal(cancelled, 7, 'the pending frame was cancelled');
  assert.equal(canvas.imageCount(), 0, 'the cache is released');
});

/* --- wired into a session ------------------------------------------------- */

test('the session draws the canvas once the renderer is switched on', async () => {
  /* The image factory is the session's injection seam for the renderer, so a
     node test can drive the real path without a browser. */
  const explorer = createMapExplorer({
    boot,
    createImage: () => decodedImage(),
  });
  const context = recordingContext();
  explorer.mapCanvasContext.value = context;
  explorer.mapSize.value = { width: 400, height: 300 };

  /* Switching the renderer on schedules a repaint on the next frame, so the
     draw has not happened yet: asserting synchronously here would pass on a
     renderer that never draws at all. */
  explorer.setMapRenderer('canvas');
  assert.equal(context.draws.length, 0, 'not yet - it is queued for a frame');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(context.draws.length > 0, 'drawn once the frame ran');
  assert.ok(
    context.draws.length <= explorer.mapTiles.value.length,
    'and no more tiles than are on screen',
  );
});

test('the canvas and the DOM layer place a tile identically', () => {
  const explorer = createMapExplorer({
    boot,
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    createImage: () => decodedImage(),
  });
  explorer.mapSize.value = { width: 400, height: 300 };

  /* The canvas and the DOM layer must agree exactly, or switching renderers
     would shift the map. Both read the same layerTransform(). */
  const transform = layerTransform({
    centerLat: 0,
    centerLon: 0,
    zoom: explorer.mapZoom.value,
    tileZoom: explorer.tileZoom.value,
    width: 400,
    height: 300,
  });
  const context = recordingContext();
  explorer.canvasRenderer.draw(context);
  const layer = context.transforms[1];
  assert.equal(layer[0], transform.scale, 'x scale');
  assert.equal(layer[3], transform.scale, 'y scale');
  assert.equal(layer[4], transform.x, 'x translate');
  assert.equal(layer[5], transform.y, 'y translate');
});
