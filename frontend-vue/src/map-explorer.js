/*
 * The OpenStreetMap Explorer session.
 *
 * This is the *Explorer*, not a map. The things that make it the Explorer rather
 * than a tiled map are here: a droppable pin, a persisted collection of named
 * places, the colour filters, flights between places, and loaded GeoJSON layers.
 *
 * The map itself - the view state, pan/zoom, inertia, the gesture handlers, tile
 * loading, the rate floor, and measurement - lives in map-viewport.js, shared with
 * the Google viewer. That split is not tidiness for its own sake: the two had
 * drifted, most visibly in the rate floor, which existed in one and was documented
 * as applying to both. See map-viewport.js for what a session is expected to add.
 *
 * --- How the layer is drawn -------------------------------------------------
 *
 * Tiles are never repositioned in the DOM. Each one sits at its absolute
 * world-pixel position (left = tileX * 256) inside a single layer, and the layer
 * carries one transform. Panning and zooming therefore write exactly one
 * property, which the compositor handles, instead of invalidating the layout of
 * every tile on every frame. Writing left/top per tile was the source of the
 * stutter this design replaced.
 *
 * --- How zooming stays continuous ------------------------------------------
 *
 * Zoom is a float (`mapZoom`), but tile servers serve whole zoom levels. So the
 * drawn tile set is committed at an integer `tileZoom`, and the layer is scaled
 * by 2^(tileZoom - mapZoom) while the gesture runs. Pinching therefore scales the
 * tiles that are already on screen instead of blanking the map and fetching a new
 * set dozens of times, and the new set is only committed - at a scale of 1 - when
 * the gesture settles or drifts far enough that the blur would show.
 *
 * Tile images come from openstreetmap.org. The published tile usage policy asks
 * for a real identifying User-Agent and forbids bulk downloading; a desktop viewer
 * showing one map at a time is well inside those limits, but a build
 * redistributed to many machines should point `tileUrl` at its own tile server.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import {
  bearingDegrees,
  compassPoint,
  distanceMeters,
  formatCoordinates,
  formatDistance,
  formatDistanceImperial,
  normalizeLocation,
} from './geo.js';
import { geojsonShapes } from './map-geojson-view.js';
import { places as appPlaces } from './map-places.js';
import {
  easeInOutCubic,
  interpolateView,
  MAX_ZOOM,
  projectToPixel,
  TILE_BUFFER,
  TILE_SIZE,
} from './map-projection.js';
import {
  createMapViewport,
  DEFAULT_RATE_FLOOR_MS,
  ZOOM_COMMIT_THRESHOLD,
} from './map-viewport.js';

/*
 * The colour filters, which are a contract rather than a preference: each name
 * here has a matching `.map-canvas.filter-<name>` rule in index.css. An
 * unrecognised name would produce a class with no rules and a map that looks
 * broken with no way back, so the list is closed on both sides.
 */
export const MAP_FILTERS = [
  'none',
  'grayscale',
  'dark',
  'sepia',
  'vivid',
  'faded',
];

/*
 * The slippy-map tile URL. Every segment is interpolated: `${x}` and `${y}` are
 * substitutions, and dropping the `$` from either would quietly request a literal
 * `{x}` tile that 404s for every zoom level - which is the kind of thing that looks
 * like "the map is just blank" rather than like a typo. The linter flags the unused
 * parameters if that happens again.
 */
const DEFAULT_TILE_URL = (z, x, y) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

/* --- session -------------------------------------------------------------- */

/*
 * The Explorer session. External dependencies are injected so the reactive state
 * and the travel math are testable in plain node while the tile URL, tile size,
 * and the scheduler stay overridable.
 */
export function createMapExplorer({
  doc = null,
  boot = restoredWorkspace,
  tileUrl = DEFAULT_TILE_URL,
  tileSize = TILE_SIZE,
  initialZoom = 2,
  initialCenter = { lat: 20, lon: 0 },
  animate = (fn) =>
    globalThis.requestAnimationFrame?.(fn) ?? globalThis.setTimeout(fn, 16),
  cancelFrame = (handle) =>
    globalThis.cancelAnimationFrame?.(handle) ??
    globalThis.clearTimeout(handle),
  /* Injectable so the canvas renderer is testable outside a browser, which has no
     Image constructor. */
  createImage = () => new globalThis.Image(),
  now = () => Date.now(),
  buffer = TILE_BUFFER,
  rateFloorMs = DEFAULT_RATE_FLOOR_MS,
  /*
   * The saved places, injected rather than imported at the top of the file.
   * map-places.js is a session of its own and importing it here would make the map
   * own a second copy of the collection - the same reason the schema takes
   * normalizeLocation from geo.js rather than from the map. Injected rather than
   * used directly so a test that builds a session still gets one with no places,
   * instead of a shared collection that leaks between them.
   */
  mapPlaces = null,
} = {}) {
  const theDoc = () => doc ?? globalThis.document;

  /* --- what makes this the Explorer and not a map -------------------------- */

  const mapPin = ref(null);
  const mapStatus = ref('Click the map to drop a pin for a section.');
  const mapStatusError = ref(false);
  /* View options persisted by the workspace, so the map looks the same next
     launch. Each is a small enum rather than a free string so a corrupt stored
     value cannot invent a filter class that does not exist. */
  const mapFilter = ref(boot.map.filter || 'none');
  const mapSidebarOpen = ref(boot.map.sidebarOpen !== false);

  let flight = null;

  function setMapStatus(message, isError = false) {
    mapStatus.value = message;
    mapStatusError.value = isError;
  }

  /*
   * Drops the pin at a geographic position, without moving the map.
   *
   * Takes a coordinate rather than a pointer event, because that is what both
   * callers have: the viewport's click hook has already converted the event, and
   * toc-outline.js has a stored location. pickMapLocation() below wraps it for a
   * raw event.
   */
  function pinLocation(location) {
    const point = normalizeLocation(location);
    if (!point) {
      setMapStatus('That point is outside the map area.', true);
      return false;
    }
    mapPin.value = point;
    setMapStatus(`Pin dropped at ${formatCoordinates(point)}.`);
    return true;
  }

  /* The event-taking form, kept because that is the public shape the app and the
     tests have always used: it converts and delegates, so there is one place that
     decides what a valid pin is. */
  function pickMapLocation(event) {
    return pinLocation(vp.locationFromEvent(event));
  }

  /* Announces where the centre is after a keyboard move. */
  function reportViewCoordinates() {
    setMapStatus(
      `Centre ${formatCoordinates({ lat: vp.mapCenter.value.lat, lon: vp.mapCenter.value.lon })} · ${vp.mapZoomLabel.value}.`,
    );
  }

  function setMapFilter(name) {
    /* An unknown name would produce a class with no rules and a map that looks
       broken with no way back, so anything unrecognised resets to none. */
    mapFilter.value = MAP_FILTERS.includes(name) ? name : 'none';
  }

  function toggleMapSidebar() {
    mapSidebarOpen.value = !mapSidebarOpen.value;
  }

  /*
   * The place the cursor readout measures against: whatever was last opened.
   *
   * Stored as an id rather than as the place object, so selecting does not pin a
   * snapshot of a record the sidebar can still rename or remove. The computed
   * re-resolves, which is what makes a deleted place fall out of the selection on
   * its own instead of leaving the readout measuring to nowhere.
   */
  const selectedPlaceId = ref(null);
  const selectedPlace = computed(() => {
    /* Optional chaining rather than a default: a session built without places must
       measure nothing rather than throw on the first pointer move. */
    const collection = mapPlaces ?? [];
    return (
      collection.find((place) => place.id === selectedPlaceId.value) ?? null
    );
  });

  function selectPlace(placeId) {
    selectedPlaceId.value = placeId;
  }

  function clearPlaceSelection() {
    selectedPlaceId.value = null;
  }

  /*
   * How far the pointer is from a chosen place, and which way.
   *
   * The scale bar answers "how big is a pixel here"; this answers "how far is the
   * thing I am pointing at", which is the question a reader with a cursor over a
   * marker is actually asking and which no amount of zooming answers directly.
   *
   * Derived from two existing refs rather than stored, so it cannot go stale: the
   * readout follows the pointer because the pointer did.
   */
  const mapCursorBearing = computed(() => {
    const from = vp.mapCursorLocation.value;
    if (!from || !selectedPlace.value) return null;
    const meters = distanceMeters(from, selectedPlace.value);
    if (meters === null) return null;
    const bearing = bearingDegrees(from, selectedPlace.value);
    return {
      meters,
      bearing,
      label: formatDistance(meters),
      imperial: formatDistanceImperial(meters),
      point: compassPoint(bearing),
      /* Three digits is what a compass rose shows, and it is enough to tell one
         bearing from another without implying survey precision. */
      bearingLabel: `${Math.round(bearing).toString().padStart(3, '0')}°`,
    };
  });

  /*
   * The pin's offset inside the viewport. Derived from the two projections rather
   * than from a drag handler, so the pin stays put while the map pans under it and
   * moves with the map when the centre changes.
   *
   * The projection is at the *view* zoom, not the tile zoom, so a pin and a marker
   * both stay correct while a pinch is partway between two levels.
   */
  function projectAtViewZoom(point) {
    return projectToPixel(point.lon, point.lat, vp.mapZoom.value);
  }

  function offsetFor(point) {
    if (!point) return null;
    const { width, height } = vp.mapSize.value;
    if (!(width > 0) || !(height > 0)) return null;
    const center = projectToPixel(
      vp.mapCenter.value.lon,
      vp.mapCenter.value.lat,
      vp.mapZoom.value,
    );
    const here = projectAtViewZoom(point);
    return {
      left: here.x - center.x + width / 2,
      top: here.y - center.y + height / 2,
    };
  }

  const mapPinOffset = computed(() => offsetFor(mapPin.value));

  /* Where a saved place sits in the viewport, in the same terms as the pin. */
  function placeMarkerOffset(place) {
    return offsetFor(place);
  }

  /* --- travel between places ------------------------------------------------ */

  /*
   * A reduced-motion preference means the journey itself is the problem, not a
   * nicety, so the map arrives there directly.
   */
  const reduceMotion = () =>
    theDoc()?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
      ?.matches === true;

  /*
   * Where a place should be looked at from: close enough to be useful, but never
   * further out than the reader already was, and never below what the viewport can
   * actually cover.
   */
  function targetViewFor(location) {
    return {
      lat: location.lat,
      lon: location.lon,
      /*
       * Zoom *in* to 13 when the reader is further out than that, and never further
       * out than they already were. min() here would do the opposite and pull a
       * reader who is already at street level back to a continent.
       */
      zoom: Math.max(
        vp.mapZoom.value,
        Math.min(13, MAX_ZOOM),
        vp.minViewZoom.value,
      ),
    };
  }

  /*
   * Arriving at a place: the view is already there, so this only drops the pin,
   * re-commits the tiles, and says where the map ended up. Kept separate from
   * ending a journey so an immediate jump - nothing to animate, a reduced-motion
   * preference, or a place already on screen - lands the same way a flight does.
   */
  function arriveAt(pin) {
    mapPin.value = pin;
    vp.commitTileZoom();
    setMapStatus(
      pin.label
        ? `${pin.label} · ${formatCoordinates(pin)}`
        : `Showing ${formatCoordinates(pin)}.`,
    );
  }

  /* Ends a journey. Only a journey that actually arrived moves the pin. */
  function finishFlight(landed) {
    if (!flight) return;
    cancelFrame(flight.handle);
    const arrived = flight.pin;
    flight = null;
    vp.mapFlying.value = false;
    if (landed && arrived) arriveAt(arrived);
  }

  /*
   * Stops a journey where it is. The pin does not move: the reader took over, so
   * their intent is the last word, and a cancelled flight leaves the map where they
   * were rather than arriving somewhere they did not choose. The outgoing tile layer
   * stays until the current set has loaded, so even an interrupted flight is
   * standing on real ground.
   */
  function cancelFlight() {
    if (!flight) return;
    finishFlight(false);
  }

  function stepFlight() {
    if (!flight) return;
    const progress = Math.min(
      1,
      Math.max(0, (now() - flight.started) / flight.duration),
    );
    const view = interpolateView(
      flight.from,
      flight.to,
      easeInOutCubic(progress),
    );
    vp.mapZoom.value = view.zoom;
    vp.mapCenter.value = { lat: view.lat, lon: view.lon };
    vp.clampCenterToWorld();
    /*
     * The same threshold a pinch uses. Committing here rather than once at the end
     * is what keeps the ground under the journey sharp: without it the source tiles
     * would be magnified by the whole zoom difference, which for a jump from zoom
     * 10 to 14 is sixteen times. The previous integer level stays underneath as the
     * backdrop, so the map is never blank mid-flight.
     */
    if (
      Math.abs(vp.mapZoom.value - vp.tileZoom.value) >= ZOOM_COMMIT_THRESHOLD
    ) {
      vp.commitTileZoom();
    }
    if (progress >= 1) {
      vp.commitTileZoom();
      finishFlight(true);
      return;
    }
    flight.handle = animate(stepFlight);
  }

  /*
   * Travels to a saved place instead of teleporting to it.
   *
   * Returns false only when the value is not a usable coordinate, so a caller can
   * report a bad link instead of silently doing nothing.
   */
  function flyToLocation(value, { duration = 560 } = {}) {
    const location = normalizeLocation(value);
    if (!location) {
      setMapStatus('That section has no saved location.', true);
      return false;
    }
    vp.stopGlide();
    cancelFlight();

    const from = {
      lat: vp.mapCenter.value.lat,
      lon: vp.mapCenter.value.lon,
      zoom: vp.mapZoom.value,
    };
    const to = targetViewFor(location);
    const settled =
      from.lat === to.lat && from.lon === to.lon && from.zoom === to.zoom;
    if (settled || duration <= 0 || reduceMotion()) {
      /* Still has to go there - arriving is not the same as being there. */
      vp.mapCenter.value = { lat: to.lat, lon: to.lon };
      vp.mapZoom.value = to.zoom;
      vp.clampCenterToWorld();
      arriveAt(location);
      return true;
    }

    vp.mapFlying.value = true;
    setMapStatus(
      location.label ? `Travelling to ${location.label}…` : 'Travelling…',
    );
    flight = { from, to, pin: location, started: now(), duration, handle: 0 };
    stepFlight();
    return true;
  }

  /*
   * Centres the map on a stored location and pins it. This is the immediate jump:
   * flyToLocation() is what a reader-initiated move should use, and this is what
   * the map does when there is nothing to animate or nothing to travel.
   */
  function showMapLocation(value) {
    const location = normalizeLocation(value);
    if (!location) {
      setMapStatus('That section has no saved location.', true);
      return false;
    }
    vp.stopGlide();
    vp.mapCenter.value = { lat: location.lat, lon: location.lon };
    vp.clampCenterToWorld();
    mapPin.value = location;
    /* Jump in close enough to be useful, but never zoom *out* to get there, and
       never below what this viewport can actually cover. */
    if (vp.mapZoom.value < 13) vp.mapZoom.value = 13;
    vp.mapZoom.value = Math.max(vp.mapZoom.value, vp.minViewZoom.value);
    vp.commitTileZoom();
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

  /* --- GeoJSON layers ----------------------------------------------------- */

  const geojsonLayers = ref([]);
  const geojsonVisible = ref(true);

  function loadGeoJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target.result);
          if (data.type !== 'FeatureCollection' && data.type !== 'Feature') {
            reject(new Error('Not a valid GeoJSON file'));
            return;
          }
          const features =
            data.type === 'FeatureCollection' ? data.features : [data];
          const layer = {
            name: file.name.replace(/\.geojson$/i, ''),
            features,
            visible: true,
          };
          geojsonLayers.value = [...geojsonLayers.value, layer];
          setMapStatus(`Loaded ${features.length} features from ${file.name}`);
          resolve(layer);
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function toggleGeoJSONLayer(index) {
    const layers = [...geojsonLayers.value];
    layers[index] = { ...layers[index], visible: !layers[index].visible };
    geojsonLayers.value = layers;
  }

  function removeGeoJSONLayer(index) {
    const layers = [...geojsonLayers.value];
    layers.splice(index, 1);
    geojsonLayers.value = layers;
    setMapStatus('Removed GeoJSON layer.');
  }

  function clearGeoJSONLayers() {
    geojsonLayers.value = [];
    setMapStatus('Cleared all GeoJSON layers.');
  }

  function setGeoJSONVisible(visible) {
    geojsonVisible.value = visible;
  }

  const geojsonFeatureCount = computed(() =>
    geojsonLayers.value.reduce((sum, layer) => sum + layer.features.length, 0),
  );

  /*
   * The loaded layers as drawable shapes, in viewport pixels.
   *
   * Renderer-independent on purpose. It used to be reachable only from the canvas
   * renderer, so with `#map-toggle-renderer` set to `dom` an imported
   * FeatureCollection drew nothing while the sidebar reported it as loaded - a
   * control that reported success and showed an empty map. Both renderers read this
   * now, so the toggle chooses only how the *tiles* are drawn.
   */
  const geojsonShapesFor = computed(() =>
    geojsonShapes({
      layers: geojsonVisible.value ? geojsonLayers.value : [],
      transform: vp.mapTransform.value,
      tileSize,
      tileZoom: vp.tileZoom.value,
    }),
  );

  /* --- the shared viewport ------------------------------------------------- */

  /*
   * Built after the session's own state so the hooks below can close over it. The
   * hooks are only ever called from a gesture, by which time `vp` is assigned - the
   * alternative, passing this session's state into the viewport as constructor
   * arguments, is the coupling that let the two copies drift apart.
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
    rateFloorMs,
    renderer: boot.map.renderer,
    showGrid: boot.map.showGrid,
    showCursor: boot.map.showCursor !== false,
    getShapes: () => geojsonShapesFor.value,
    /* A click that was not a drag drops a pin. The viewport has already turned the
       event into a coordinate, so the hook takes the position, not the event. */
    onClick: pinLocation,
    /* A grab, a wheel, or a key the map used means the reader wants the map to stop
       moving on its own. */
    onInterrupt: cancelFlight,
    /* Announce where a keyboard move landed. */
    onViewMoved: reportViewCoordinates,
  });

  /*
   * The Explorer's own teardown first, then the viewport's. The order is not
   * incidental: a flight holds a frame handle that only this session's cancelFrame
   * can cancel, so it cannot be cancelled after the viewport has been disposed.
   */
  function disposeMapExplorer() {
    cancelFlight();
    clearPlaceSelection();
    vp.disposeViewport();
  }

  return {
    /* --- the Explorer's own surface --- */
    mapPin,
    mapPinOffset,
    mapStatus,
    mapStatusError,
    mapFilter,
    mapSidebarOpen,
    mapCursorBearing,
    selectedPlace,
    selectPlace,
    clearPlaceSelection,
    placeMarkerOffset,
    pickMapLocation,
    pinLocation,
    setMapStatus,
    setMapFilter,
    toggleMapSidebar,
    mapFilters: MAP_FILTERS,
    /* --- travel --- */
    flyToLocation,
    showMapLocation,
    cancelFlight,
    targetViewFor,
    /* --- GeoJSON --- */
    geojsonLayers,
    geojsonVisible,
    geojsonFeatureCount,
    geojsonShapesFor,
    loadGeoJSON,
    toggleGeoJSONLayer,
    removeGeoJSONLayer,
    clearGeoJSONLayers,
    setGeoJSONVisible,
    mapBadge,
    disposeMapExplorer,
    /*
     * Everything else is the shared viewport, spread in rather than listed. Listing
     * it would be forty lines to keep in step with map-viewport.js by hand, and a
     * name added there but not here is exactly the kind of drift this file's
     * header says it exists to prevent. The Explorer's own names are above, so a
     * collision is a duplicate key that JavaScript silently resolves in the
     * viewport's favour - hence the explicit ordering rather than
     * `...viewportView` first.
     */
    ...vp,
  };
}

/* The app's single map explorer session, like every other tool. */
const session = createMapExplorer({ mapPlaces: appPlaces });

export const mapElement = session.mapElement;
export const mapCenter = session.mapCenter;
export const mapZoom = session.mapZoom;
export const tileZoom = session.tileZoom;
export const mapSize = session.mapSize;
export const mapPin = session.mapPin;
export const mapPinOffset = session.mapPinOffset;
export const mapStatus = session.mapStatus;
export const mapStatusError = session.mapStatusError;
export const mapPanning = session.mapPanning;
export const mapFlying = session.mapFlying;
export const mapLoading = session.mapLoading;
export const mapFilter = session.mapFilter;
export const mapRenderer = session.mapRenderer;
export const mapShowGrid = session.mapShowGrid;
export const mapShowCursor = session.mapShowCursor;
export const mapSidebarOpen = session.mapSidebarOpen;
export const mapCursorLocation = session.mapCursorLocation;
export const mapCanvasContext = session.mapCanvasContext;
export const mapFilters = session.mapFilters;
export const mapTiles = session.mapTiles;
export const mapAdmittedTiles = session.mapAdmittedTiles;
export const previousLayer = session.previousLayer;
export const previousTransform = session.previousTransform;
export const mapTransform = session.mapTransform;
export const mapScaleBar = session.mapScaleBar;
export const mapCursorBearing = session.mapCursorBearing;
export const selectedPlace = session.selectedPlace;
export const selectPlace = session.selectPlace;
export const clearPlaceSelection = session.clearPlaceSelection;
export const mapZoomLabel = session.mapZoomLabel;
export const minViewZoom = session.minViewZoom;
export const mapBadge = session.mapBadge;
export const tileSource = session.tileSource;
export const isTileAdmitted = session.isTileAdmitted;
export const admitTiles = session.admitTiles;
export const setMapStatus = session.setMapStatus;
export const noteTileLoaded = session.noteTileLoaded;
export const setMapFilter = session.setMapFilter;
export const setMapRenderer = session.setMapRenderer;
export const toggleMapSidebar = session.toggleMapSidebar;
export const setMapShowGrid = session.setMapShowGrid;
export const setMapShowCursor = session.setMapShowCursor;
export const placeMarkerOffset = session.placeMarkerOffset;
export const pickMapLocation = session.pickMapLocation;
export const pinLocation = session.pinLocation;
export const canvasRenderer = session.canvasRenderer;
export const commitTileZoom = session.commitTileZoom;
export const panMapByPixels = session.panMapByPixels;
export const zoomMap = session.zoomMap;
export const zoomIn = session.zoomIn;
export const zoomOut = session.zoomOut;
export const locationFromEvent = session.locationFromEvent;
export const showMapLocation = session.showMapLocation;
export const flyToLocation = session.flyToLocation;
export const cancelFlight = session.cancelFlight;
export const measureMap = session.measureMap;
export const startMapObserver = session.startMapObserver;
export const disposeMapExplorer = session.disposeMapExplorer;
export const handleMapPointerDown = session.handleMapPointerDown;
export const handleMapPointerMove = session.handleMapPointerMove;
export const handleMapPointerUp = session.handleMapPointerUp;
export const handleMapPointerCancel = session.handleMapPointerCancel;
export const handleMapDoubleClick = session.handleMapDoubleClick;
export const handleMapWheel = session.handleMapWheel;
export const handleMapKeydown = session.handleMapKeydown;
export const handleMapPointerLeave = session.handleMapPointerLeave;
export const handleWindowResize = session.handleWindowResize;
export const geojsonLayers = session.geojsonLayers;
export const geojsonVisible = session.geojsonVisible;
export const geojsonFeatureCount = session.geojsonFeatureCount;
export const geojsonShapesFor = session.geojsonShapesFor;
export const loadGeoJSON = session.loadGeoJSON;
export const toggleGeoJSONLayer = session.toggleGeoJSONLayer;
export const removeGeoJSONLayer = session.removeGeoJSONLayer;
export const clearGeoJSONLayers = session.clearGeoJSONLayers;
export const setGeoJSONVisible = session.setGeoJSONVisible;
