/*
 * GeoJSON as drawable shapes, independent of who draws them.
 *
 * The overlays used to be reachable only through the canvas renderer, because the
 * projection was inlined in map-canvas.js as two local helpers and the whole
 * conversion to screen coordinates happened mid-draw. That made the canvas the
 * only renderer that could show a layer: pick the DOM renderer and an imported
 * FeatureCollection drew nothing while the sidebar reported it as loaded.
 *
 * So the conversion lives here, as pure functions from a layer list and a layer
 * transform to circles and paths. map-canvas.js feeds the result to a 2D context
 * and App.vue feeds the same result to an <svg>; the two cannot drift, and the
 * math is testable without a browser or a canvas stub.
 *
 * Positions are viewport pixels, the same space the tile layer's transform
 * produces, so the overlay is a sibling of that layer rather than a child: it
 * carries no transform of its own.
 */

import { latToTileY, lonToTileX } from './map-projection.js';

/*
 * One colour per layer, cycled. Kept in step with map-canvas.js's palette on
 * purpose - a layer that is one colour in the canvas and another in the DOM would
 * read as two different layers.
 */
export const GEOJSON_COLORS = [
  '#e74c3c',
  '#3498db',
  '#2ecc71',
  '#f39c12',
  '#9b59b6',
  '#1abc9c',
];

export function geojsonColorAt(layerIndex) {
  return GEOJSON_COLORS[layerIndex % GEOJSON_COLORS.length];
}

/*
 * Projects one [lon, lat] to a viewport pixel.
 *
 * The projection happens at the *tile* zoom, not at the view zoom and not at
 * zoom 0, because that is the space the tile layer's children are positioned in:
 * a tile's `left` is `lonToTileX(lon, tileZoom) * tileSize`, and the transform
 * then scales it to the view zoom. Projecting anywhere else silently agrees at
 * scale 1 and is wrong everywhere else, which is why the canvas path's
 * hardcoded zoom 0 put every overlay thousands of pixels off the ground beneath
 * it at any real zoom level.
 */
function project(coordinate, transform, tileSize, tileZoom) {
  const [lon, lat] = coordinate;
  return {
    x: lonToTileX(lon, tileZoom) * tileSize * transform.scale + transform.x,
    y: latToTileY(lat, tileZoom) * tileSize * transform.scale + transform.y,
  };
}

/*
 * A circle of constant *screen* size, however far the layer is zoomed. Dividing
 * by the scale is what keeps a marker the same size on screen at z3 and z19; the
 * canvas path does the same, so the two agree.
 */
const POINT_RADIUS_PX = 6;
const STROKE_WIDTH_PX = 2;

/*
 * The points of a path, already projected. Both renderers take points rather
 * than an SVG path string: the DOM writes them into a `d` attribute, and the
 * canvas feeds them to moveTo/lineTo. Going through a string would mean the
 * canvas needed Path2D, which the test stub does not have and which buys
 * nothing here.
 */
function projectAll(coordinates, transform, tileSize, tileZoom) {
  return coordinates.map((coordinate) =>
    project(coordinate, transform, tileSize, tileZoom),
  );
}

/*
 * Two decimals is about a third of a pixel at 1x, which is below anything the
 * compositor can show and keeps both the path strings and the point objects
 * small. Full floats would be larger than the geometry they describe.
 */
function round(value) {
  return Math.round(value * 100) / 100;
}

function roundedPoints(points) {
  return points.map((point) => ({ x: round(point.x), y: round(point.y) }));
}

/* The `d` attribute for an SVG path, from the same points the canvas traces. */
export function pathData(points, closed = false) {
  if (!points || points.length === 0) return '';
  const commands = points.map(
    (point, index) =>
      `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`,
  );
  return closed ? `${commands.join(' ')} Z` : commands.join(' ');
}

/*
 * Turns the visible layers into circles and paths.
 *
 * Returns `{ circles, paths }` where a circle is
 * `{ key, x, y, r, color }` and a path is
 * `{ key, points, color, closed, strokeWidth }`. `closed` distinguishes a filled
 * polygon ring from a stroked line. Use `pathData(points, closed)` for the `d`
 * attribute when writing SVG.
 *
 * Every shape carries the key of the feature it came from, so a renderer can key
 * its elements and Vue can reuse them across a pan instead of rebuilding the
 * whole overlay.
 */
export function geojsonShapes({
  layers,
  transform,
  tileSize = 256,
  tileZoom = 0,
}) {
  const circles = [];
  const paths = [];
  if (!layers || layers.length === 0) return { circles, paths };

  layers.forEach((layer, layerIndex) => {
    if (layer.visible === false) return;
    if (!Array.isArray(layer.features)) return;
    const color = geojsonColorAt(layerIndex);

    layer.features.forEach((feature, featureIndex) => {
      const geometry = feature?.geometry;
      if (!geometry || !Array.isArray(geometry.coordinates)) return;
      const key = `${layerIndex}:${featureIndex}`;
      const geometryType = geometry.type;

      if (geometryType === 'Point') {
        const { x, y } = project(
          geometry.coordinates,
          transform,
          tileSize,
          tileZoom,
        );
        circles.push({
          key,
          x: round(x),
          y: round(y),
          r: POINT_RADIUS_PX / transform.scale,
          color,
        });
        return;
      }

      if (geometryType === 'LineString') {
        if (geometry.coordinates.length < 2) return;
        paths.push({
          key,
          points: roundedPoints(
            projectAll(geometry.coordinates, transform, tileSize, tileZoom),
          ),
          color,
          closed: false,
          strokeWidth: STROKE_WIDTH_PX / transform.scale,
        });
        return;
      }

      if (geometryType === 'Polygon') {
        for (const ring of geometry.coordinates) {
          if (!Array.isArray(ring) || ring.length < 3) continue;
          paths.push({
            key: `${key}:${paths.length}`,
            points: roundedPoints(
              projectAll(ring, transform, tileSize, tileZoom),
            ),
            color,
            closed: true,
            strokeWidth: STROKE_WIDTH_PX / transform.scale,
          });
        }
      }
    });
  });

  return { circles, paths };
}
