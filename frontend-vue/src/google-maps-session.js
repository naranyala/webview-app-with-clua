/*
 * The Google Maps Viewer session: a render-only Google Maps tile viewer.
 *
 * Unlike the OpenStreetMap Explorer, this is deliberately minimal - it renders
 * Google Maps tiles without an API key by using Google's public tile servers. No
 * places, no pins, no saved locations. Just pan, zoom, and view.
 *
 * What it adds to a map is three things: the layer selector, the URL parser, and
 * the GeoJSON export. Everything else - the view state, pan/zoom, the gesture
 * handlers, tile loading, the rate floor, and measurement - is the shared viewport
 * in map-viewport.js, the same one the Explorer composes. That used to be a
 * near-copy of the Explorer's own map code, and the copies had already drifted: the
 * rate floor existed in one of them and was documented as applying to both.
 *
 * --- The licence question, which this file does not answer ------------------
 *
 * `mt1.google.com/vt/lyrs=` is Google's internal raster endpoint, used here with no
 * API key and no Maps Platform agreement. That is a policy question rather than a
 * code one, and TODO-094 is where it is being decided: drop this viewer, move the
 * URL into configuration, or gate it behind an explicit opt-in. Until then the
 * endpoint is here, and it is named in the shipped CSP allowlist - which is a
 * statement about reachability, not about permission.
 *
 * Tile layers:
 *   m  - standard road map
 *   s  - satellite
 *   y  - hybrid (satellite + labels)
 *   t  - terrain
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import { formatCoordinates } from './geo.js';
import { TILE_BUFFER, TILE_SIZE } from './map-projection.js';
import { createMapViewport } from './map-viewport.js';
import { plural } from './workspace.js';

export const ZOOM_COMMIT_THRESHOLD = 0.5;
export const ZOOM_COMMIT_DELAY_MS = 160;

export const GOOGLE_TILE_URLS = {
  m: (z, x, y) => `https://mt1.google.com/vt/lyrs=m&x=${x}&y=${y}&z=${z}`,
  s: (z, x, y) => `https://mt1.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`,
  y: (z, x, y) => `https://mt1.google.com/vt/lyrs=y&x=${x}&y=${y}&z=${z}`,
  t: (z, x, y) => `https://mt1.google.com/vt/lyrs=t&x=${x}&y=${y}&z=${z}`,
};

export const GOOGLE_MAP_LAYERS = ['m', 's', 'y', 't'];

/*
 * Reads a Google Maps URL for places.
 *
 * Hoisted out of the session because it is pure: it reads a string, touches no
 * state, and needs no browser. That is also why it had no test before - a
 * function this shape is exercised through a session only by accident.
 *
 * The patterns are tried in a fixed order and each only runs if nothing before it
 * matched, because real URLs nest: every /place/ URL also contains an @lat,lon
 * segment, and a map URL can carry both ?q and ?ll. Reading each independently
 * would return the same location two or three times.
 *
 * A /maps/search/ URL yields a named place with a null coordinate. That is
 * deliberate rather than a half-finished geocode: there is no geocoder here, so
 * the name is kept and the place is skipped by the export instead of having a
 * position invented for it.
 */
export function parseGoogleMapsUrl(url) {
  const places = [];
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    /* Not a URL at all. An empty list is the answer; the caller reports it. */
    return places;
  }
  const path = parsed.pathname;
  const search = parsed.search;

  const placeMatch = path.match(
    /\/place\/([^/]+)\/@([-\d.]+),([-\d.]+)(?:,(\d+)z)?/,
  );
  if (placeMatch) {
    const name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    const coordinate = usableCoordinate(placeMatch[2], placeMatch[3]);
    if (coordinate) {
      places.push({
        name,
        ...coordinate,
        zoom: zoomOr(placeMatch[4], 15),
        source: 'place',
      });
    }
  }

  /*
   * A search URL carries a query, not a position. The name is kept because it is
   * the only thing in the URL worth keeping, and the coordinate stays null so the
   * export skips it - see the note above.
   */
  const searchMatch = path.match(/\/maps\/search\/([^/]+)/);
  if (searchMatch) {
    places.push({
      name: decodeURIComponent(searchMatch[1].replace(/\+/g, ' ')),
      lat: null,
      lon: null,
      zoom: 12,
      source: 'search',
    });
  }

  /*
   * The three fallback patterns only run if nothing before them matched. Real
   * URLs nest - a /place/ URL also contains an @lat,lon segment - so testing each
   * independently would report one location two or three times over.
   */
  const coordMatch = path.match(/@([-\d.]+),([-\d.]+)(?:,(\d+)z)?/);
  const qMatch = search.match(/[?&]q=([-\d.]+),([-\d.]+)/);
  const llMatch = search.match(/[?&]ll=([-\d.]+),([-\d.]+)/);

  if (places.length === 0) {
    const candidate = coordMatch ?? qMatch ?? llMatch;
    if (candidate) {
      const coordinate = usableCoordinate(candidate[1], candidate[2]);
      if (coordinate) {
        places.push({
          name: `Location ${coordinate.lat.toFixed(4)}, ${coordinate.lon.toFixed(4)}`,
          ...coordinate,
          zoom: zoomOr(coordMatch ? candidate[3] : null, 15),
          source: coordMatch ? 'coordinates' : qMatch ? 'query' : 'll',
        });
      }
    }
  }

  return places;
}

/*
 * Parses a matched lat/lon pair, or returns null when it is not a coordinate.
 *
 * The range check is not decoration. The patterns match `999,999` happily, and
 * these places are exported as GeoJSON Points, so an out-of-range value would
 * produce a file that other tools reject - long after the moment it could have
 * been refused. Longitude is bounded the same way rather than wrapped: a URL is
 * not a projection, and quietly turning 999 into -1 would invent a location.
 */
function usableCoordinate(rawLat, rawLon) {
  const lat = Number.parseFloat(rawLat);
  const lon = Number.parseFloat(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function zoomOr(raw, fallback) {
  const zoom = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : fallback;
}

export function createGoogleMapsViewer({
  doc = null,
  boot = restoredWorkspace,
  tileUrl = GOOGLE_TILE_URLS.m,
  tileSize = TILE_SIZE,
  initialZoom = 2,
  initialCenter = { lat: 20, lon: 0 },
  animate = (fn) =>
    globalThis.requestAnimationFrame?.(fn) ?? globalThis.setTimeout(fn, 16),
  cancelFrame = (handle) =>
    globalThis.cancelAnimationFrame?.(handle) ??
    globalThis.clearTimeout(handle),
  createImage = () => new globalThis.Image(),
  now = () => Date.now(),
  buffer = TILE_BUFFER,
} = {}) {
  const mapStatus = ref('Drag to pan, scroll to zoom.');
  const mapStatusError = ref(false);
  /* The only view option that is this viewer's own: which Google basemap to draw. */
  const mapLayer = ref(boot.googleMap?.layer || 'm');

  function setMapStatus(message, isError = false) {
    mapStatus.value = message;
    mapStatusError.value = isError;
  }

  /* An unrecognized name would build a tile URL with no badge or styling for it. */
  function setMapLayer(name) {
    mapLayer.value = GOOGLE_MAP_LAYERS.includes(name) ? name : 'm';
  }

  /* Announces where the centre is after a keyboard move. */
  function reportViewCoordinates() {
    setMapStatus(
      `Centre ${formatCoordinates({ lat: vp.mapCenter.value.lat, lon: vp.mapCenter.value.lon })} · ${vp.mapZoomLabel.value}.`,
    );
  }

  /*
   * The shared viewport.
   *
   * Note what is *not* passed: no onClick, because this viewer has no pins, and no
   * onInterrupt, because it has no flights to cancel. The viewport treats a missing
   * hook as a no-op, which is what keeps "render-only" from turning into a set of
   * `if (hasPins)` branches threaded through the gesture code.
   *
   * The rate floor comes along with it, which is the visible point of the
   * extraction: this viewer previously fetched as fast as the DOM asked for tiles.
   */
  const vp = createMapViewport({
    doc,
    tileUrl,
    tileSize,
    initialZoom,
    initialCenter,
    animate,
    cancelFrame,
    createImage,
    now,
    buffer,
    renderer: boot.googleMap?.renderer,
    showGrid: boot.googleMap?.showGrid,
    showCursor: boot.googleMap?.showCursor !== false,
    canvasSelector: '#google-map-canvas-surface',
    /* Announce where a keyboard move landed. */
    onViewMoved: reportViewCoordinates,
  });

  function disposeGoogleMapsViewer() {
    vp.disposeViewport();
  }

  const mapBadge = computed(() => {
    const layerName =
      { m: 'Road', s: 'Satellite', y: 'Hybrid', t: 'Terrain' }[
        mapLayer.value
      ] || 'Road';
    return `${layerName} · z${vp.mapZoom.value.toFixed(0)}`;
  });

  /* --- URL parsing -------------------------------------------------------- */

  const parsedPlaces = ref([]);

  function addPlaceFromUrl(url) {
    const places = parseGoogleMapsUrl(url);
    if (places.length === 0) {
      setMapStatus('Could not parse that Google Maps URL.', true);
      return false;
    }
    const newPlaces = [...parsedPlaces.value];
    for (const place of places) {
      if (
        !newPlaces.some(
          (p) =>
            p.lat === place.lat && p.lon === place.lon && p.name === place.name,
        )
      ) {
        newPlaces.push(place);
      }
    }
    parsedPlaces.value = newPlaces;
    setMapStatus(
      `Added ${places.length} ${plural(places.length, 'place')} from URL. Total: ${newPlaces.length}`,
    );
    return true;
  }

  function removeParsedPlace(index) {
    const next = [...parsedPlaces.value];
    next.splice(index, 1);
    parsedPlaces.value = next;
    setMapStatus(
      `Removed place. ${next.length} ${plural(next.length, 'place')} remaining.`,
    );
  }

  function clearParsedPlaces() {
    parsedPlaces.value = [];
    setMapStatus('Cleared all parsed places.');
  }

  /* --- GeoJSON export ----------------------------------------------------- */

  function exportGeoJSON() {
    if (parsedPlaces.value.length === 0) {
      setMapStatus('No places to export. Parse a URL first.', true);
      return null;
    }
    const features = parsedPlaces.value
      .filter((p) => p.lat !== null && p.lon !== null)
      .map((p) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
        properties: {
          name: p.name,
          source: p.source,
          zoom: p.zoom,
        },
      }));
    const geojson = {
      type: 'FeatureCollection',
      features,
    };
    return JSON.stringify(geojson, null, 2);
  }

  function downloadGeoJSON() {
    const geojson = exportGeoJSON();
    if (!geojson) return;
    const blob = new Blob([geojson], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'google-maps-places.geojson';
    a.click();
    URL.revokeObjectURL(url);
    setMapStatus(
      `Exported ${parsedPlaces.value.length} ${plural(parsedPlaces.value.length, 'place')} to GeoJSON.`,
    );
  }

  return {
    /* --- this viewer's own surface --- */
    mapStatus,
    mapStatusError,
    mapLayer,
    setMapStatus,
    setMapLayer,
    mapLayers: GOOGLE_MAP_LAYERS,
    mapBadge,
    createImage,
    disposeGoogleMapsViewer,
    /* --- URL parsing and export --- */
    parsedPlaces,
    addPlaceFromUrl,
    removeParsedPlace,
    clearParsedPlaces,
    exportGeoJSON,
    downloadGeoJSON,
    /* The shared map, spread in rather than listed - see the note in
       map-explorer.js, which has the same reasoning for the same spread. */
    ...vp,
  };
}

const session = createGoogleMapsViewer();

export const googleMapElement = session.mapElement;
export const googleMapCenter = session.mapCenter;
export const googleMapZoom = session.mapZoom;
export const googleTileZoom = session.tileZoom;
export const googleMapSize = session.mapSize;
export const googleMapStatus = session.mapStatus;
export const googleMapStatusError = session.mapStatusError;
export const googleMapPanning = session.mapPanning;
export const googleMapLoading = session.mapLoading;
export const googleMapLayer = session.mapLayer;
export const googleMapRenderer = session.mapRenderer;
export const googleMapShowGrid = session.mapShowGrid;
export const googleMapShowCursor = session.mapShowCursor;
export const googleMapCursorLocation = session.mapCursorLocation;
export const googleMapCanvasContext = session.mapCanvasContext;
export const googleMapTiles = session.mapTiles;
export const googlePreviousLayer = session.previousLayer;
export const googlePreviousTransform = session.previousTransform;
export const googleMapTransform = session.mapTransform;
export const googleMapScaleBar = session.mapScaleBar;
export const googleMapZoomLabel = session.mapZoomLabel;
export const googleMinViewZoom = session.minViewZoom;
export const googleMapBadge = session.mapBadge;
export const googleTileSource = session.tileSource;
export const setGoogleMapStatus = session.setMapStatus;
export const noteGoogleTileLoaded = session.noteTileLoaded;
export const setGoogleMapLayer = session.setMapLayer;
export const setGoogleMapRenderer = session.setMapRenderer;
export const setGoogleMapShowGrid = session.setMapShowGrid;
export const setGoogleMapShowCursor = session.setMapShowCursor;
export const googleCanvasRenderer = session.canvasRenderer;
export const googleMapLayers = session.mapLayers;
export const googleCommitTileZoom = session.commitTileZoom;
export const panGoogleMapByPixels = session.panMapByPixels;
export const zoomGoogleMap = session.zoomMap;
export const googleZoomIn = session.zoomIn;
export const googleZoomOut = session.zoomOut;
export const googleLocationFromEvent = session.locationFromEvent;
export const measureGoogleMap = session.measureMap;
export const startGoogleMapObserver = session.startMapObserver;
export const disposeGoogleMapsViewer = session.disposeGoogleMapsViewer;
export const handleGoogleMapPointerDown = session.handleMapPointerDown;
export const handleGoogleMapPointerMove = session.handleMapPointerMove;
export const handleGoogleMapPointerUp = session.handleMapPointerUp;
export const handleGoogleMapPointerCancel = session.handleMapPointerCancel;
export const handleGoogleMapPointerLeave = session.handleMapPointerLeave;
export const handleGoogleMapDoubleClick = session.handleMapDoubleClick;
export const handleGoogleMapWheel = session.handleMapWheel;
export const handleGoogleMapKeydown = session.handleMapKeydown;
export const googleParsedPlaces = session.parsedPlaces;
export const addGooglePlaceFromUrl = session.addPlaceFromUrl;
export const removeGoogleParsedPlace = session.removeParsedPlace;
export const clearGoogleParsedPlaces = session.clearParsedPlaces;
export const exportGoogleGeoJSON = session.exportGeoJSON;
export const downloadGoogleGeoJSON = session.downloadGeoJSON;
export const handleGoogleWindowResize = session.handleWindowResize;
