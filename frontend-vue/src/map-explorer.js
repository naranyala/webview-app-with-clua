/*
 * OpenStreetMap Explorer session: tile math, panning, zooming, and the pin the
 * TOC Manager references.
 *
 * The projection is Web Mercator (EPSG:3857), the one every OSM raster tile
 * scheme uses, so the map is the standard library-free formula rather than a
 * third-party dependency: the whole bundle inlines into one HTML file, and this
 * module adds no network surface beyond the tile requests themselves.
 *
 * Everything the geometry needs is a pure function at the top of the file and is
 * unit tested without a DOM. The reactive layer below owns only what the
 * template binds: the centre, the zoom, the viewport size reported by a
 * ResizeObserver, and the pin.
 *
 * Tile images come from openstreetmap.org. The published tile usage policy asks
 * for a real identifying User-Agent and forbids bulk downloading; a desktop
 * viewer that shows one map at a time is well inside those limits, but a build
 * redistributed to many machines should point `tileUrl` at its own tile server.
 */
import { computed, ref } from 'vue';

/* One OSM raster tile is 256 CSS pixels square. */
export const TILE_SIZE = 256;

/*
 * Mercator diverges at the poles, so the usable latitude range is bounded. This
 * is the standard cut-off (~85.0511 degrees), beyond which the projection would
 * produce an infinite y and an unusable tile index.
 */
export const MAX_LATITUDE = 85.0511287798;

export const MIN_ZOOM = 1;
/* The public OSM tile server has no tiles past 19. */
export const MAX_ZOOM = 19;

/*
 * How far a pointer may travel between press and release and still count as a
 * click rather than a pan. A few pixels of jitter is normal on a trackpad or a
 * touchscreen, and dropping a pin on every such wobble would be worse than the
 * occasional missed click.
 */
export const CLICK_SLOP_PX = 4;

const DEFAULT_TILE_URL = (z, x, y) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

/* --- projection (pure) ----------------------------------------------------- */

/* Clamps a latitude into the range Mercator can represent. */
export function clampLatitude(value) {
  const latitude = Number(value);
  if (!Number.isFinite(latitude)) return 0;
  return Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, latitude));
}

/* Wraps a longitude into [-180, 180) so panning past the seam stays continuous. */
export function wrapLongitude(value) {
  const longitude = Number(value);
  if (!Number.isFinite(longitude)) return 0;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/* Clamps a zoom level to the range the tile server actually serves. */
export function clampZoom(value) {
  const zoom = Math.round(Number(value));
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
  return 2 ** clampZoom(zoom);
}

/*
 * Every tile needed to cover a viewport, positioned in CSS pixels relative to
 * the viewport's own top-left corner.
 *
 * The range comes from the centre pixel minus half the viewport, and each tile
 * is offset by that same origin, so dragging the centre by exactly one tile
 * width moves every tile by exactly one tile width with no drift. Rows outside
 * the served range are skipped: Mercator rows past the pole cut-off are not
 * served, and column indices wrap so panning across the antimeridian is seamless.
 */
export function visibleTiles({
  centerLat,
  centerLon,
  zoom,
  width,
  height,
  tileSize = TILE_SIZE,
}) {
  const safeZoom = clampZoom(zoom);
  const span = 2 ** safeZoom;
  if (!(width > 0) || !(height > 0)) return [];

  const center = projectToPixel(centerLon, centerLat, safeZoom);
  const originX = center.x - width / 2;
  const originY = center.y - height / 2;

  const firstX = Math.floor(originX / tileSize);
  const firstY = Math.floor(originY / tileSize);
  const lastX = Math.floor((originX + width) / tileSize);
  const lastY = Math.floor((originY + height) / tileSize);

  const tiles = [];
  for (let x = firstX; x <= lastX; x += 1) {
    const wrappedX = ((x % span) + span) % span;
    for (let y = firstY; y <= lastY; y += 1) {
      if (y < 0 || y >= span) continue;
      tiles.push({
        key: `${safeZoom}/${x}/${y}/${wrappedX}`,
        x: wrappedX,
        y,
        z: safeZoom,
        left: x * tileSize - originX,
        top: y * tileSize - originY,
      });
    }
  }
  return tiles;
}

/*
 * A pin position, or null when the value is not a usable coordinate pair.
 *
 * Stored links go through this, so a corrupt or hand-edited record reads as "no
 * location" instead of putting NaN on the map. Out-of-range values are rejected
 * rather than clamped, because a latitude of 400 is a broken record and silently
 * turning it into the north pole would hide the corruption.
 */
export function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = Number(value.lat);
  const lon = Number(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  return {
    /* Six decimals is ~11 cm, well past GPS accuracy, and keeps the
       persisted record short. */
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(wrapLongitude(lon) * 1e6) / 1e6,
    label: label.slice(0, 120),
  };
}

/* "51.507351, -0.127758" - the order every mapping UI uses. */
export function formatCoordinates(location) {
  const point = normalizeLocation(location);
  if (!point) return 'No location';
  return `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
}

/* --- session -------------------------------------------------------------- */

/*
 * The map session. External dependencies are injected so the reactive state and
 * the pan/zoom math are testable in plain node while the tile URL and tile size
 * stay overridable.
 */
export function createMapExplorer({
  doc = null,
  tileUrl = DEFAULT_TILE_URL,
  tileSize = TILE_SIZE,
  initialZoom = 2,
  initialCenter = { lat: 20, lon: 0 },
} = {}) {
  const theDoc = () => doc ?? globalThis.document;

  const mapElement = ref(null);
  const mapCenter = ref({
    lat: clampLatitude(initialCenter.lat),
    lon: wrapLongitude(initialCenter.lon),
  });
  const mapZoom = ref(clampZoom(initialZoom));
  const mapSize = ref({ width: 0, height: 0 });
  const mapPin = ref(null);
  const mapStatus = ref('Click the map to drop a pin for a section.');
  const mapStatusError = ref(false);

  let dragStart = null;
  let observer = null;

  function setMapStatus(message, isError = false) {
    mapStatus.value = message;
    mapStatusError.value = isError;
  }

  /* The tiles that cover the current viewport. */
  const mapTiles = computed(() =>
    visibleTiles({
      centerLat: mapCenter.value.lat,
      centerLon: mapCenter.value.lon,
      zoom: mapZoom.value,
      width: mapSize.value.width,
      height: mapSize.value.height,
      tileSize,
    }),
  );

  /*
   * The pin's offset inside the viewport. Derived from the two projections
   * rather than from a drag handler, so the pin stays put while the map pans
   * under it and moves with the map when the centre changes.
   */
  const mapPinOffset = computed(() => {
    const point = mapPin.value;
    if (!point) return null;
    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    const pinPixel = projectToPixel(point.lon, point.lat, mapZoom.value);
    return {
      left: pinPixel.x - center.x + mapSize.value.width / 2,
      top: pinPixel.y - center.y + mapSize.value.height / 2,
    };
  });

  function tileSource(tile) {
    return tileUrl(tile.z, tile.x, tile.y, tileSize);
  }

  /* --- panning and zooming ------------------------------------------------- */

  /*
   * Moves the centre by a pixel delta. The delta is unprojected rather than
   * divided by a tile size, so panning tracks the cursor at every zoom level
   * instead of only at the one where a tile happens to equal its pixel count.
   */
  function panMapByPixels(dx, dy) {
    const current = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    mapCenter.value = unprojectFromPixel(
      current.x - dx,
      current.y - dy,
      mapZoom.value,
    );
  }

  /*
   * Zooms while keeping the geographic position under (anchorX, anchorY) - the
   * cursor, or the viewport centre for the +/- buttons - pinned in place.
   *
   * The anchor is unprojected at the old zoom, reprojected at the new one, and
   * then the centre is solved backwards from where that point must land. The
   * solve has to add half the viewport back, because a centre is measured from
   * the world's middle while the anchor is measured from the viewport's top-left
   * corner. With an unmeasured viewport the anchor collapses to the centre, so
   * the fallback is "zoom about the middle" rather than a jump to 0,0.
   */
  function zoomMap(delta, anchorX = null, anchorY = null) {
    const nextZoom = clampZoom(mapZoom.value + delta);
    if (nextZoom === mapZoom.value) return;
    const targetX = anchorX ?? mapSize.value.width / 2;
    const targetY = anchorY ?? mapSize.value.height / 2;

    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    const anchorHere = unprojectFromPixel(
      center.x - mapSize.value.width / 2 + targetX,
      center.y - mapSize.value.height / 2 + targetY,
      mapZoom.value,
    );
    const anchorThere = projectToPixel(
      anchorHere.lon,
      anchorHere.lat,
      nextZoom,
    );

    mapZoom.value = nextZoom;
    mapCenter.value = unprojectFromPixel(
      anchorThere.x - targetX + mapSize.value.width / 2,
      anchorThere.y - targetY + mapSize.value.height / 2,
      nextZoom,
    );
  }

  function zoomIn() {
    zoomMap(1);
  }

  function zoomOut() {
    zoomMap(-1);
  }

  /* --- pointer interaction ------------------------------------------------- */

  /*
   * The viewport's top-left in projected pixels, which every screen-to-world
   * conversion is relative to.
   */
  function mapOrigin() {
    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    return {
      x: center.x - mapSize.value.width / 2,
      y: center.y - mapSize.value.height / 2,
    };
  }

  /*
   * Converts a pointer event to a geographic position. Returns null when the
   * viewport has no measured size or the element has no box, which is the one
   * case where a click cannot be turned into a coordinate.
   */
  function locationFromEvent(event) {
    const element = mapElement.value;
    if (!element || !(mapSize.value.width > 0) || !(mapSize.value.height > 0))
      return null;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds) return null;
    const origin = mapOrigin();
    return unprojectFromPixel(
      origin.x + (event.clientX - bounds.left),
      origin.y + (event.clientY - bounds.top),
      mapZoom.value,
    );
  }

  /* Drops the pin where the user clicked, without moving the map. */
  function pickMapLocation(event) {
    const point = locationFromEvent(event);
    if (!point) return false;
    const location = normalizeLocation(point);
    if (!location) {
      setMapStatus('That point is outside the map area.', true);
      return false;
    }
    mapPin.value = location;
    setMapStatus(`Pin dropped at ${formatCoordinates(location)}.`);
    return true;
  }

  function handleMapPointerDown(event) {
    if (event.button !== 0) return;
    dragStart = {
      pointerId: event.pointerId,
      /*
       * startX/startY never move: they are what the click-versus-drag test is
       * measured against. lastX/lastY is what the pan is measured against, and
       * conflating the two made every drag look like a click that happened to
       * end at the last move.
       */
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    mapElement.value?.setPointerCapture?.(event.pointerId);
  }

  function handleMapPointerMove(event) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    panMapByPixels(
      event.clientX - dragStart.lastX,
      event.clientY - dragStart.lastY,
    );
    /* Advancing the last position is what makes a drag track the pointer: without
       it every move would re-pan by the full distance from where it began. */
    dragStart.lastX = event.clientX;
    dragStart.lastY = event.clientY;
  }

  /*
   * A drag that ends over a tiny movement is a click, not a pan, so only then
   * does the pin move. Without the threshold, every pan would also leave a pin
   * wherever the pointer happened to stop.
   */
  function handleMapPointerUp(event) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    const moved = Math.hypot(
      event.clientX - dragStart.startX,
      event.clientY - dragStart.startY,
    );
    const wasDrag = moved > CLICK_SLOP_PX;
    mapElement.value?.releasePointerCapture?.(event.pointerId);
    dragStart = null;
    if (!wasDrag) pickMapLocation(event);
  }

  function handleMapPointerCancel() {
    dragStart = null;
  }

  /* Zooms toward the cursor rather than the centre. */
  function handleMapWheel(event) {
    event.preventDefault?.();
    const element = mapElement.value;
    if (!element) return;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds) return;
    zoomMap(
      event.deltaY < 0 ? 1 : -1,
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  }

  /* --- viewport measurement ------------------------------------------------ */

  /*
   * The tile grid needs a pixel size, which only the laid-out element knows. A
   * ResizeObserver reports it, and a window resize listener covers the hosts
   * where the observer never fires.
   */
  function measureMap() {
    const element = mapElement.value;
    if (!element) return;
    const width = Math.floor(element.clientWidth || 0);
    const height = Math.floor(element.clientHeight || 0);
    if (width <= 0 || height <= 0) return;
    const current = mapSize.value;
    if (current.width === width && current.height === height) return;
    mapSize.value = { width, height };
  }

  function handleWindowResize() {
    measureMap();
  }

  function startMapObserver() {
    const element = mapElement.value;
    if (!element) return;
    measureMap();
    const ObserverClass =
      theDoc()?.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (typeof ObserverClass === 'function') {
      observer = new ObserverClass(() => measureMap());
      observer.observe(element);
    }
    theDoc()?.defaultView?.addEventListener?.('resize', handleWindowResize);
  }

  function disposeMapExplorer() {
    observer?.disconnect();
    observer = null;
    dragStart = null;
    theDoc()?.defaultView?.removeEventListener?.('resize', handleWindowResize);
  }

  /*
   * Centres the map on a stored location and pins it. Returns false when the
   * value is not a usable coordinate, so a caller can report the bad link
   * instead of silently doing nothing.
   */
  function showMapLocation(value) {
    const location = normalizeLocation(value);
    if (!location) {
      setMapStatus('That section has no saved location.', true);
      return false;
    }
    mapCenter.value = { lat: location.lat, lon: location.lon };
    mapPin.value = location;
    mapZoom.value = Math.max(mapZoom.value, 13);
    setMapStatus(
      location.label
        ? `${location.label} · ${formatCoordinates(location)}`
        : `Showing ${formatCoordinates(location)}.`,
    );
    return true;
  }

  /* Menu badge: what the explorer would show right now. */
  const mapBadge = computed(() =>
    mapPin.value
      ? `Pin at ${formatCoordinates(mapPin.value)}`
      : 'Pick a location on the map',
  );

  return {
    mapElement,
    mapCenter,
    mapZoom,
    mapSize,
    mapPin,
    mapPinOffset,
    mapStatus,
    mapStatusError,
    mapTiles,
    mapBadge,
    tileSource,
    setMapStatus,
    panMapByPixels,
    zoomMap,
    zoomIn,
    zoomOut,
    locationFromEvent,
    pickMapLocation,
    showMapLocation,
    measureMap,
    startMapObserver,
    disposeMapExplorer,
    handleMapPointerDown,
    handleMapPointerMove,
    handleMapPointerUp,
    handleMapPointerCancel,
    handleMapWheel,
    handleWindowResize,
  };
}

/* The app's single map explorer session, like every other tool. */
const session = createMapExplorer();

export const mapElement = session.mapElement;
export const mapCenter = session.mapCenter;
export const mapZoom = session.mapZoom;
export const mapSize = session.mapSize;
export const mapPin = session.mapPin;
export const mapPinOffset = session.mapPinOffset;
export const mapStatus = session.mapStatus;
export const mapStatusError = session.mapStatusError;
export const mapTiles = session.mapTiles;
export const mapBadge = session.mapBadge;
export const tileSource = session.tileSource;
export const setMapStatus = session.setMapStatus;
export const panMapByPixels = session.panMapByPixels;
export const zoomMap = session.zoomMap;
export const zoomIn = session.zoomIn;
export const zoomOut = session.zoomOut;
export const locationFromEvent = session.locationFromEvent;
export const pickMapLocation = session.pickMapLocation;
export const showMapLocation = session.showMapLocation;
export const measureMap = session.measureMap;
export const startMapObserver = session.startMapObserver;
export const disposeMapExplorer = session.disposeMapExplorer;
export const handleMapPointerDown = session.handleMapPointerDown;
export const handleMapPointerMove = session.handleMapPointerMove;
export const handleMapPointerUp = session.handleMapPointerUp;
export const handleMapPointerCancel = session.handleMapPointerCancel;
export const handleMapWheel = session.handleMapWheel;
export const handleWindowResize = session.handleWindowResize;
