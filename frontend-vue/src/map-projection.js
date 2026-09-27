/*
 * Web Mercator projection and tile layout: the whole map on paper.
 *
 * Everything here is a pure function of its arguments, with no state and no DOM,
 * so the geometry can be tested directly against known slippy-map tile numbers
 * rather than through the session. The session in map-explorer.js is the only
 * thing that owns live state; it composes these and adds the behaviour.
 *
 * The tile set and the layer transform are here rather than in the session
 * because they are the same calculation: a tile's position is an absolute world
 * pixel and the transform is what places them, and the two have to agree exactly
 * or the map drifts a pixel per pan.
 */
import { clampLatitude, wrapLongitude } from './geo.js';

/* One OSM raster tile is 256 CSS pixels square. */
export const TILE_SIZE = 256;

export const MIN_ZOOM = 1;
/* The public OSM tile server has no tiles past 19. */
export const MAX_ZOOM = 19;

/*
 * How many tile rings to request beyond each edge of the viewport. One ring is
 * the cheapest setting that hides a normal pan; every extra ring multiplies the
 * requests the tile server sees, which the usage policy cares about.
 */
export const TILE_BUFFER = 1;

/*
 * Clamps a zoom level to the range the tile server serves. The result is a
 * float: fractional zoom is what makes a pinch continuous.
 */
export function clampZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/* World size in pixels at a zoom: the map is this many pixels square. */
function worldSize(zoom) {
  return TILE_SIZE * 2 ** clampZoom(zoom);
}

/*
 * Geographic position to global pixel coordinates, the standard slippy-map
 * projection. The fractional part of each axis is what makes a sub-tile cursor
 * reading possible, so this deliberately does not floor to a tile index.
 */
export function projectToPixel(longitude, latitude, zoom) {
  const scale = worldSize(zoom);
  const safeLatitude = clampLatitude(latitude);
  const safeLongitude = wrapLongitude(longitude);
  /* asinh(tan(latitude)) written so the poles cannot overflow the log. */
  const sine = Math.sin((safeLatitude * Math.PI) / 180);
  return {
    x: ((safeLongitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * scale,
  };
}

/*
 * The exact inverse of projectToPixel: latitude = (2*atan(exp(y)) - pi/2) in
 * radians, evaluated through the Gudermannian form to stay stable at the poles.
 */
export function unprojectFromPixel(x, y, zoom) {
  const scale = worldSize(zoom);
  const normalized = 0.5 - y / scale;
  const latitude =
    90 - (360 * Math.atan(Math.exp(-2 * Math.PI * normalized))) / Math.PI;
  return {
    lat: clampLatitude(latitude),
    lon: wrapLongitude((x / scale) * 360 - 180),
  };
}

/* Fractional tile index along the x axis at a zoom. */
export function lonToTileX(longitude, zoom) {
  return ((wrapLongitude(longitude) + 180) / 360) * 2 ** clampZoom(zoom);
}

/* Fractional tile index along the y axis at a zoom. */
export function latToTileY(latitude, zoom) {
  const safeLatitude = clampLatitude(latitude);
  const sine = Math.sin((safeLatitude * Math.PI) / 180);
  return (
    (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) *
    2 ** clampZoom(zoom)
  );
}

/* Tiles along one axis at a zoom. */
export function tileCount(zoom) {
  return 2 ** Math.round(clampZoom(zoom));
}

/*
 * The lowest zoom that still covers a viewport with tiles.
 *
 * A world map shrinks with zoom, so at low levels it can be smaller than the
 * window: at zoom 1 the whole world is 512 pixels across, and a 900-pixel-wide
 * pane simply has no tiles for the rest. Rather than showing that void and
 * looking broken, the floor rises with the viewport until the world is at least
 * as large as the window.
 */
export function minimumZoomFor(width, height, tileSize = TILE_SIZE) {
  const largest = Math.max(width || 0, height || 0);
  if (!(largest > 0)) return MIN_ZOOM;
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.ceil(Math.log2(largest / tileSize))),
  );
}

/* Rounds a fractional zoom to the whole level a tile server serves. */
export function committedZoom(zoom) {
  return Math.round(clampZoom(zoom));
}

/*
 * Every tile needed to cover a viewport, plus `buffer` rings beyond each edge.
 *
 * The range is floored, so it only changes when the viewport actually crosses a
 * tile line - not on every pixel of a pan and not on every frame of a pinch.
 * That stability is what keeps Vue from churning the tile elements mid-gesture.
 *
 * Rows outside the served range are skipped (Mercator rows past the pole cut-off
 * are not served); columns wrap, so panning across the antimeridian is seamless.
 *
 * Each tile's position is its absolute world-pixel origin, not an offset from the
 * first tile in the set: the layer transform places them, and a tile that keeps
 * its position never triggers layout.
 */
export function visibleTiles({
  centerLat,
  centerLon,
  zoom,
  width,
  height,
  tileSize = TILE_SIZE,
  buffer = TILE_BUFFER,
  scale = 1,
}) {
  const safeZoom = committedZoom(zoom);
  const span = 2 ** safeZoom;
  if (!(width > 0) || !(height > 0)) return [];

  /* The displayed extent, expressed in the tiles' own pixels. */
  const factor = scale > 0 ? scale : 1;
  const viewWidth = width / factor;
  const viewHeight = height / factor;

  const center = projectToPixel(centerLon, centerLat, safeZoom);
  const originX = center.x - viewWidth / 2;
  const originY = center.y - viewHeight / 2;
  const padX = buffer * tileSize;
  const padY = buffer * tileSize;

  const firstX = Math.floor((originX - padX) / tileSize);
  const firstY = Math.floor((originY - padY) / tileSize);
  const lastX = Math.floor((originX + viewWidth + padX) / tileSize);
  const lastY = Math.floor((originY + viewHeight + padY) / tileSize);

  const tiles = [];
  for (let x = firstX; x <= lastX; x += 1) {
    const wrappedX = ((x % span) + span) % span;
    for (let y = firstY; y <= lastY; y += 1) {
      if (y < 0 || y >= span) continue;
      tiles.push({
        /* The key carries the unwrapped x so a tile keeps its identity across
           the seam, where the same wrapped tile is needed at two positions. */
        key: `${safeZoom}/${x}/${y}`,
        x: wrappedX,
        y,
        z: safeZoom,
        left: x * tileSize,
        top: y * tileSize,
      });
    }
  }
  return tiles;
}

/*
 * The layer transform for a given view.
 *
 * A child positioned at `left`/`top` renders at translate + left * scale under
 * `transform-origin: 0 0`. A tile's `left` is its world pixel at the *tile* zoom,
 * so that product is where the tile's edge lands at the *view* zoom, and the
 * translate has to be the view's own top-left corner:
 *
 *     screen = left * scale + translate
 *            = left * scale - viewTopLeft + halfViewport
 *
 * The view's top-left is the centre projected at the view zoom, minus half the
 * viewport. Note the asymmetry that makes this easy to get wrong: the translate
 * uses the *view* projection and is NOT multiplied by the scale. Projecting at
 * the tile zoom and scaling the translate instead happens to agree at scale 1,
 * so the error only shows up once a pinch is partway between two levels.
 *
 * The scale is 2^(zoom - tileZoom): zooming in past the level the tiles were
 * fetched at magnifies them, which is what makes a pinch continuous instead of a
 * sequence of full re-fetches.
 */
export function layerTransform({
  centerLat,
  centerLon,
  zoom,
  tileZoom,
  width,
  height,
}) {
  const factor = 2 ** (clampZoom(zoom) - committedZoom(tileZoom));
  const view = projectToPixel(centerLon, centerLat, zoom);
  const x = width / 2 - view.x;
  const y = height / 2 - view.y;
  return {
    scale: factor,
    x,
    y,
    css: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${factor.toFixed(4)})`,
  };
}

/*
 * Ground resolution at a latitude and zoom, in metres per CSS pixel. The
 * circumference term is the standard Web Mercator scale factor.
 */
export function metersPerPixel(latitude, zoom) {
  const safeLatitude = clampLatitude(latitude);
  return (
    (156543.03392804097 * Math.cos((safeLatitude * Math.PI) / 180)) /
    2 ** clampZoom(zoom)
  );
}

/*
 * A round distance that fits `maxWidth` pixels: the largest 1/2/5 x 10^n metres
 * no wider than the allowance, so the bar always reads as a round number.
 */
export function scaleBarFor(latitude, zoom, maxWidth = 120) {
  const resolution = metersPerPixel(latitude, zoom);
  if (!(resolution > 0) || !(maxWidth > 0)) {
    return { meters: 0, pixels: 0, label: '', imperial: '' };
  }
  const target = resolution * maxWidth;
  const power = 10 ** Math.floor(Math.log10(target));
  let meters = power;
  for (const step of [2, 5, 10]) {
    if (step * power <= target) meters = step * power;
  }
  const pixels = meters / resolution;
  const feet = meters * 3.280839895;
  return {
    meters,
    pixels,
    label: meters >= 1000 ? `${meters / 1000} km` : `${meters} m`,
    imperial:
      feet >= 5280
        ? `${(feet / 5280).toFixed(1)} mi`
        : `${Math.round(feet)} ft`,
  };
}
