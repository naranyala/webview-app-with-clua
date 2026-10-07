/*
 * The GeoJSON overlay, and the loader behind it.
 *
 * Two things are pinned here. First, that a loaded layer is visible under both
 * renderers: the overlay used to be reachable only from the canvas path, so the
 * DOM renderer showed an empty map while the sidebar reported the file as loaded.
 * Second, that the shapes are the same ones both renderers draw, since the point
 * of extracting them was to make that true rather than to have two copies.
 *
 * Everything here is pure or injected, so none of it needs a browser.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapExplorer } from '../src/map-explorer.js';
import {
  geojsonColorAt,
  geojsonShapes,
  pathData,
} from '../src/map-geojson-view.js';
import { layerTransform } from '../src/map-projection.js';

/* A viewport transform for a known view, so positions can be pinned by hand. */
const TRANSFORM = layerTransform({
  centerLat: 0,
  centerLon: 0,
  zoom: 4,
  tileZoom: 4,
  width: 800,
  height: 600,
});

function layers(...features) {
  return [{ name: 'layer', visible: true, features }];
}

function point(lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

function line(...pairs) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: pairs },
  };
}

function polygon(...rings) {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: rings } };
}

/* --- the shape conversion --------------------------------------------------- */

test('a point lands where the projection puts it', () => {
  const { circles } = geojsonShapes({
    layers: layers(point(0, 0)),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.equal(circles.length, 1);
  /* The centre of the view is the middle of the viewport. */
  assert.equal(circles[0].x, 400);
  assert.equal(circles[0].y, 300);
});

test('a point keeps its screen size at every zoom', () => {
  /* The radius divides by the scale, so a marker does not grow into a disc as
     the reader zooms in. This is the same rule the canvas path follows. */
  const radiusAt = (zoom) => {
    const transform = layerTransform({
      centerLat: 0,
      centerLon: 0,
      zoom,
      tileZoom: zoom,
      width: 800,
      height: 600,
    });
    return geojsonShapes({
      layers: layers(point(0, 0)),
      transform,
      tileZoom: zoom,
    }).circles[0].r;
  };

  /*
   * Two steps, because they are different questions. Committed zooms all have
   * scale 1, so they can only show that the radius is a constant 6 pixels. The
   * interesting case is a pinch partway between two levels, where the transform
   * is scaling a tile set it is not going to keep: there the stored radius has to
   * shrink in step, or the marker grows while the reader zooms.
   */
  for (const zoom of [2, 8, 16]) {
    assert.equal(radiusAt(zoom), 6, `committed zoom ${zoom} draws a 6px point`);
  }

  const pinching = [4, 4.5, 5].map((zoom) => {
    const transform = layerTransform({
      centerLat: 0,
      centerLon: 0,
      zoom,
      tileZoom: 4,
      width: 800,
      height: 600,
    });
    const circle = geojsonShapes({
      layers: layers(point(0, 0)),
      transform,
      tileZoom: 4,
    }).circles[0];
    return circle.r * transform.scale;
  });
  assert.ok(
    pinching.every((size) => Math.abs(size - 6) < 1e-9),
    'and a mid-pinch point is still 6px on screen',
  );
});

test('a line becomes one open path and a polygon a closed one', () => {
  const { paths } = geojsonShapes({
    layers: layers(
      line([0, 0], [1, 1]),
      polygon([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.equal(paths.length, 2);
  assert.equal(paths[0].closed, false, 'a line is stroked, not filled');
  assert.equal(paths[1].closed, true, 'a polygon ring is closed');
});

test('a polygon ring with too few points is dropped rather than drawn', () => {
  const { paths } = geojsonShapes({
    layers: layers(
      polygon([
        [0, 0],
        [1, 1],
      ]),
    ),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.equal(paths.length, 0, 'two points is a line, not an area');
});

test('a hidden layer draws nothing', () => {
  const { circles, paths } = geojsonShapes({
    layers: [
      {
        name: 'off',
        visible: false,
        features: [point(0, 0), line([0, 0], [1, 1])],
      },
    ],
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.equal(circles.length, 0);
  assert.equal(paths.length, 0);
});

test('malformed features are skipped, not thrown on', () => {
  const { circles, paths } = geojsonShapes({
    layers: layers(
      null,
      { geometry: null },
      { geometry: { type: 'Point' } },
      { geometry: { type: 'Point', coordinates: 'nope' } },
      { geometry: { type: 'Multipolygon', coordinates: [] } },
      point(0, 0),
    ),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.equal(circles.length, 1, 'only the good one survived');
  assert.equal(paths.length, 0);
});

test('each layer gets its own colour, and the palette cycles', () => {
  const shapes = geojsonShapes({
    layers: [
      { name: 'a', visible: true, features: [point(0, 0)] },
      { name: 'b', visible: true, features: [point(1, 1)] },
    ],
    transform: TRANSFORM,
    tileZoom: 4,
  });
  assert.notEqual(shapes.circles[0].color, shapes.circles[1].color);
  assert.equal(geojsonColorAt(0), geojsonColorAt(6), 'the palette repeats');
});

test('every shape carries a key a renderer can use', () => {
  const { circles, paths } = geojsonShapes({
    layers: layers(
      point(0, 0),
      polygon([
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  const keys = [...circles, ...paths].map((shape) => shape.key);
  assert.equal(new Set(keys).size, keys.length, 'no two shapes share a key');
});

test('an empty or absent layer list produces nothing', () => {
  assert.deepEqual(geojsonShapes({ layers: [], transform: TRANSFORM }), {
    circles: [],
    paths: [],
  });
  assert.deepEqual(geojsonShapes({ layers: null, transform: TRANSFORM }), {
    circles: [],
    paths: [],
  });
});

test('positions are rounded to hundredths, not carried at full float', () => {
  const { circles } = geojsonShapes({
    layers: layers(point(12.3456789, 41.9876543)),
    transform: TRANSFORM,
    tileZoom: 4,
  });
  /* Two decimals is under a third of a pixel; a full double here would be more
     precision than the geometry itself carries. */
  assert.equal(circles[0].x, Math.round(circles[0].x * 100) / 100);
  assert.equal(circles[0].y, Math.round(circles[0].y * 100) / 100);
});

test('pathData writes the same points an SVG would', () => {
  assert.equal(
    pathData([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]),
    'M1 2 L3 4',
  );
  assert.equal(
    pathData(
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      true,
    ),
    'M1 2 L3 4 Z',
  );
  assert.equal(pathData([]), '');
});

/* --- one set of shapes for both renderers ----------------------------------- */

test('the session exposes the same shapes the canvas draws', () => {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    /* Node has no Image constructor; the tiles are not what this case is about,
       but the renderer builds one per admitted tile before it draws anything. */
    createImage: () => ({ complete: true, naturalWidth: 256, set src(_) {} }),
    animate: (fn) => {
      fn();
      return 1;
    },
    cancelFrame: () => {},
  });
  explorer.mapSize.value = { width: 800, height: 600 };

  const drawn = [];
  const context = {
    canvas: { width: 800, height: 600 },
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo(x, y) {
      drawn.push(['moveTo', x, y]);
    },
    lineTo(x, y) {
      drawn.push(['lineTo', x, y]);
    },
    closePath() {
      drawn.push(['closePath']);
    },
    arc(x, y) {
      drawn.push(['arc', x, y]);
    },
    drawImage() {},
    fill() {},
    stroke() {},
  };
  explorer.mapCanvasContext.value = context;
  explorer.mapRenderer.value = 'canvas';

  /* Loaded through the real path rather than pushed into state, so the computed
     the DOM overlay reads is the same one the canvas reads. */
  const restore = stubFileReader(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [line([0, 0], [1, 1]), point(2, 2)],
    }),
  );
  return explorer
    .loadGeoJSON(geojsonFile('route', []))
    .then(() => {
      const shapes = explorer.geojsonShapesFor.value;
      assert.equal(shapes.paths.length, 1);
      assert.equal(shapes.circles.length, 1);

      explorer.canvasRenderer.draw(context);

      /* The canvas traced the line it was handed rather than recomputing it: the
         first moveTo is the line's first point. */
      const moveTo = drawn.find((call) => call[0] === 'moveTo');
      assert.deepEqual(
        [moveTo[1], moveTo[2]],
        [shapes.paths[0].points[0].x, shapes.paths[0].points[0].y],
        'the canvas drew the line the overlay was handed',
      );
      /* And the point, at the position the overlay carries. */
      const arc = drawn.find((call) => call[0] === 'arc');
      assert.equal(arc[1], shapes.circles[0].x);
      assert.equal(arc[2], shapes.circles[0].y);
    })
    .finally(restore);
});

/* --- the loader -------------------------------------------------------------- */

function geojsonFile(name, features) {
  return {
    name: `${name}.geojson`,
    text: JSON.stringify({ type: 'FeatureCollection', features }),
  };
}

/*
 * A FileReader stand-in. The loader takes a File and reads it as text; this
 * resolves with the same event shape so the loader's own parsing and rejection
 * paths are what is under test, not the browser's file reading.
 */
function stubFileReader(text, { fail = false } = {}) {
  const original = globalThis.FileReader;
  class Reader {
    readAsText() {
      if (fail) {
        this.error = new Error('unreadable');
        queueMicrotask(() => this.onerror?.());
        return;
      }
      queueMicrotask(() => this.onload?.({ target: { result: text } }));
    }
  }
  globalThis.FileReader = Reader;
  return () => {
    globalThis.FileReader = original;
  };
}

test('a FeatureCollection becomes one layer', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [point(0, 0), line([0, 0], [1, 1])],
    }),
  );
  try {
    const layer = await explorer.loadGeoJSON(
      geojsonFile('survey', [point(0, 0)]),
    );
    assert.equal(layer.features.length, 2);
    assert.equal(layer.name, 'survey', 'the .geojson suffix is dropped');
    assert.equal(layer.visible, true);
    assert.equal(explorer.geojsonLayers.value.length, 1);
  } finally {
    restore();
  }
});

test('a bare Feature is accepted as a one-feature layer', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader(JSON.stringify(point(1, 2)));
  try {
    const layer = await explorer.loadGeoJSON(geojsonFile('one', []));
    assert.equal(layer.features.length, 1, 'wrapped rather than rejected');
  } finally {
    restore();
  }
});

test('a file that is not GeoJSON is rejected with a reason', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader(JSON.stringify({ type: 'Topology' }));
  try {
    await assert.rejects(
      explorer.loadGeoJSON(geojsonFile('wrong', [])),
      /valid GeoJSON/,
    );
    assert.equal(explorer.geojsonLayers.value.length, 0, 'nothing was added');
  } finally {
    restore();
  }
});

test('unparseable JSON is rejected rather than throwing past the promise', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader('{ not json');
  try {
    await assert.rejects(explorer.loadGeoJSON(geojsonFile('broken', [])));
    assert.equal(explorer.geojsonLayers.value.length, 0);
  } finally {
    restore();
  }
});

test('a read error surfaces instead of leaving the promise pending', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader('', { fail: true });
  try {
    await assert.rejects(
      explorer.loadGeoJSON(geojsonFile('gone', [])),
      /unreadable/,
    );
  } finally {
    restore();
  }
});

test('layers can be hidden, removed, and cleared', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader(
    JSON.stringify({ type: 'FeatureCollection', features: [point(0, 0)] }),
  );
  try {
    await explorer.loadGeoJSON(geojsonFile('a', []));
    await explorer.loadGeoJSON(geojsonFile('b', []));

    explorer.toggleGeoJSONLayer(0);
    assert.equal(explorer.geojsonLayers.value[0].visible, false);
    /* A hidden layer produces no shapes, which is what the old canvas-only
       overlay got wrong in the other direction: hidden meant invisible there
       too, but there was no way to see that from the DOM renderer. */
    assert.equal(explorer.geojsonShapesFor.value.circles.length, 1);

    explorer.removeGeoJSONLayer(0);
    assert.equal(explorer.geojsonLayers.value.length, 1);

    explorer.clearGeoJSONLayers();
    assert.equal(explorer.geojsonLayers.value.length, 0);
    assert.deepEqual(explorer.geojsonShapesFor.value, {
      circles: [],
      paths: [],
    });
  } finally {
    restore();
  }
});

test('hiding every layer clears the overlay', async () => {
  const explorer = createMapExplorer();
  const restore = stubFileReader(
    JSON.stringify({ type: 'FeatureCollection', features: [point(0, 0)] }),
  );
  try {
    await explorer.loadGeoJSON(geojsonFile('a', []));
    explorer.setGeoJSONVisible(false);
    assert.deepEqual(explorer.geojsonShapesFor.value, {
      circles: [],
      paths: [],
    });
    assert.equal(
      explorer.geojsonFeatureCount.value,
      1,
      'the features are still loaded, just not shown',
    );
  } finally {
    restore();
  }
});
