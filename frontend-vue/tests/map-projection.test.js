/*
 * The pure geometry behind both maps: the Web Mercator projection, the tile grid,
 * the layer transform, the scale bar, and the coordinate primitives.
 *
 * No session and no DOM. These are pinned against known slippy-map tile numbers
 * rather than against this implementation, so a change to a formula that breaks
 * real coordinates fails here instead of quietly shifting the map.
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
import {
  clampZoom,
  committedZoom,
  latToTileY,
  layerTransform,
  lonToTileX,
  MAX_ZOOM,
  MIN_ZOOM,
  metersPerPixel,
  projectToPixel,
  scaleBarFor,
  TILE_SIZE,
  tileCount,
  unprojectFromPixel,
} from '../src/map-projection.js';
import { close } from './support/map-fixtures.mjs';

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
