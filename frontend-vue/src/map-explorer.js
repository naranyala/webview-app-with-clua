/*
 * The OpenStreetMap Explorer session: the live view state and everything that
 * drives it.
 *
 * This is only the stateful half. The geometry it composes lives in
 * map-projection.js (the Web Mercator projection, the tile grid, the layer
 * transform), the coordinate primitives in geo.js, the gesture vocabulary in
 * map-input.js, and the canvas renderer in map-canvas.js. Keeping those apart is
 * what makes them testable without a session, and keeps this file about the one
 * thing it is for: what the map is doing right now.
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
 * by 2^(tileZoom - mapZoom) while the gesture runs. Pinching therefore scales
 * the tiles that are already on screen instead of blanking the map and fetching
 * a new set dozens of times, and the new set is only committed - at a scale of 1
 * - when the gesture settles or drifts far enough that the blur would show.
 *
 * Tiles are requested one ring beyond the viewport in every direction, so
 * panning almost never exposes a tile that was never fetched.
 *
 * Tile images come from openstreetmap.org. The published tile usage policy asks
 * for a real identifying User-Agent and forbids bulk downloading; a desktop
 * viewer showing one map at a time is well inside those limits, but a build
 * redistributed to many machines should point `tileUrl` at its own tile server.
 */
import { computed, ref } from 'vue';

import { restoredWorkspace } from './boot-state.js';
import {
  clampLatitude,
  formatCoordinates,
  normalizeLocation,
  wrapLongitude,
} from './geo.js';
import { createCanvasRenderer } from './map-canvas.js';
import {
  CLICK_SLOP_PX,
  classifyWheel,
  INERTIA_DECAY,
  INERTIA_MIN_SPEED,
  KEY_LONG_STEP_FACTOR,
  KEY_PAN_STEP_PX,
} from './map-input.js';
import {
  clampZoom,
  committedZoom,
  easeInOutCubic,
  interpolateView,
  layerTransform,
  MAX_ZOOM,
  minimumZoomFor,
  projectToPixel,
  scaleBarFor,
  TILE_BUFFER,
  TILE_SIZE,
  unprojectFromPixel,
  visibleTiles,
} from './map-projection.js';

/*
 * A pinch may drift this far from the committed integer zoom before the tile set
 * is re-committed. Smaller values keep the tiles sharper but fetch more often;
 * 0.5 caps the transient blur at about 1.4x, which reads as smooth rather than
 * soft.
 */
export const ZOOM_COMMIT_THRESHOLD = 0.5;

/* How long after the last zoom event before a pinch is committed. */
export const ZOOM_COMMIT_DELAY_MS = 160;

const DEFAULT_TILE_URL = (z, x, y) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

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

/* --- session -------------------------------------------------------------- */

/*
 * The map session. External dependencies are injected so the reactive state and
 * the pan/zoom math are testable in plain node while the tile URL, tile size,
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
  /* Injectable so the canvas renderer is testable outside a browser, which has
     no Image constructor. */
  createImage = () => new globalThis.Image(),
  now = () => Date.now(),
  buffer = TILE_BUFFER,
} = {}) {
  const theDoc = () => doc ?? globalThis.document;

  const mapElement = ref(null);
  const mapCanvasContext = ref(null);
  /*
   * Backing-store ratio for the canvas renderer. Tiles are 256 CSS pixels and the
   * public OSM server has no retina variant, so rendering above 1x only makes
   * them larger, not sharper; 1 is the honest choice and keeps the buffer small.
   */
  const pixelRatio = () => 1;
  const mapCenter = ref({
    lat: clampLatitude(initialCenter.lat),
    lon: wrapLongitude(initialCenter.lon),
  });
  /* The zoom the view is heading for. Fractional during a gesture. */
  const mapZoom = ref(clampZoom(initialZoom));
  /* The whole zoom level the currently drawn tile set belongs to. */
  const tileZoom = ref(committedZoom(initialZoom));
  const mapSize = ref({ width: 0, height: 0 });
  const mapPin = ref(null);
  const mapStatus = ref('Click the map to drop a pin for a section.');
  const mapStatusError = ref(false);
  const mapPanning = ref(false);
  /* True while the view is travelling to a saved place. */
  const mapFlying = ref(false);
  /* View options, persisted by the workspace so the map looks the same next
     launch. Each is a small enum rather than a free string so a corrupt stored
     value cannot invent a filter class that does not exist. */
  const mapFilter = ref(boot.map.filter || 'none');
  const mapRenderer = ref(boot.map.renderer === 'canvas' ? 'canvas' : 'dom');
  const mapShowGrid = ref(Boolean(boot.map.showGrid));
  const mapShowCursor = ref(boot.map.showCursor !== false);
  const mapSidebarOpen = ref(boot.map.sidebarOpen !== false);
  /* Where the pointer is, as a coordinate, for the readout under the cursor. */
  const mapCursorLocation = ref(null);

  let dragStart = null;
  let observer = null;
  let flight = null;
  let commitTimer = 0;
  let glideHandle = 0;
  /* Keys of tiles in the current set that have reported in. Reset whenever the
     set changes, so a late load from the previous set cannot make a fresh one
     look ready. */
  const loadedKeys = new Set();
  const loadedCount = ref(0);

  function setMapStatus(message, isError = false) {
    mapStatus.value = message;
    mapStatusError.value = isError;
  }

  /*
   * The canvas renderer, wired to this session's state through accessors: it
   * needs the tiles, the transform, the size and the mode, all of which change
   * while a gesture runs. See map-canvas.js for why it is not inline.
   */
  const canvasRenderer = createCanvasRenderer({
    getTiles: () => mapTiles.value,
    getTransform: () => mapTransform.value,
    getSize: () => mapSize.value,
    isEnabled: () => mapRenderer.value === 'canvas',
    tileSource,
    getContext: () => mapCanvasContext.value,
    createImage,
    animate,
    cancelFrame,
    pixelRatio,
    tileSize,
  });

  /* --- derived view -------------------------------------------------------- */

  /* The one transform that places every tile. */
  const mapTransform = computed(() =>
    layerTransform({
      centerLat: mapCenter.value.lat,
      centerLon: mapCenter.value.lon,
      zoom: mapZoom.value,
      tileZoom: tileZoom.value,
      width: mapSize.value.width,
      height: mapSize.value.height,
    }),
  );

  /* Any change to the view, the tile set, or the size needs a repaint. */
  const canvasInputs = computed(() => [
    mapTransform.value.css,
    mapSize.value.width,
    mapSize.value.height,
    mapTiles.value.length,
    mapZoom.value,
  ]);

  /* The tiles covering the viewport at the committed zoom, plus a ring. */
  const mapTiles = computed(() =>
    visibleTiles({
      centerLat: mapCenter.value.lat,
      centerLon: mapCenter.value.lon,
      zoom: tileZoom.value,
      width: mapSize.value.width,
      height: mapSize.value.height,
      tileSize,
      buffer,
      scale: mapTransform.value.scale,
    }),
  );

  /*
   * The outgoing tile set, kept mounted while the incoming one fetches so a zoom
   * commit or a flight fades over ground that is already there instead of
   * flashing the background.
   *
   * It stores the tile zoom it was fetched at, and its transform is derived
   * live from the current view. A captured transform would freeze the outgoing
   * tiles at the position they had when the commit happened, so they would sit
   * visibly misaligned for as long as they were on screen - and during a flight,
   * which animates the view, that would be the whole journey.
   */
  const previousLayer = ref(null);

  /*
   * The outgoing layer's transform, recomputed every frame from the live view.
   * Same formula as the main layer, so the two layers line up exactly and the
   * incoming tiles appear to develop out of the outgoing ones.
   */
  const previousTransform = computed(() => {
    const layer = previousLayer.value;
    if (!layer) return null;
    return layerTransform({
      centerLat: mapCenter.value.lat,
      centerLon: mapCenter.value.lon,
      zoom: mapZoom.value,
      tileZoom: layer.tileZoom,
      width: mapSize.value.width,
      height: mapSize.value.height,
    });
  });

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

  /*
   * Where a saved place sits in the viewport, in the same terms as the pin. The
   * projection is taken at the *view* zoom, so a marker stays correct while a
   * pinch is partway between two levels.
   */
  function placeMarkerOffset(place) {
    if (!place || !(mapSize.value.width > 0) || !(mapSize.value.height > 0)) {
      return null;
    }
    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    const point = projectToPixel(place.lon, place.lat, mapZoom.value);
    return {
      left: point.x - center.x + mapSize.value.width / 2,
      top: point.y - center.y + mapSize.value.height / 2,
    };
  }

  /* The round distance bar for the current scale. */
  const mapScaleBar = computed(() =>
    scaleBarFor(mapCenter.value.lat, mapZoom.value, 120),
  );

  /*
   * The lowest zoom this viewport can show, so the world always fills it. It
   * rises as the window grows, which is what keeps a wide pane from zooming out
   * past the edge of the world and showing empty background.
   */
  const minViewZoom = computed(() =>
    minimumZoomFor(mapSize.value.width, mapSize.value.height, tileSize),
  );

  /* The zoom readout: a decimal only while the view is between two levels. */
  const mapZoomLabel = computed(() => {
    const zoom = mapZoom.value;
    return Math.abs(zoom - Math.round(zoom)) < 0.05
      ? `z${Math.round(zoom)}`
      : `z${zoom.toFixed(1)}`;
  });

  function tileSource(tile) {
    return tileUrl(tile.z, tile.x, tile.y, tileSize);
  }

  /* --- tile loading ------------------------------------------------------- */

  /*
   * Derived, not stored: a loading flag that has to be poked by hand goes stale
   * the moment the tile set changes for any other reason. Comparing a live count
   * against a live total cannot.
   */
  const mapLoading = computed(() => {
    const total = mapTiles.value.length;
    return total > 0 && loadedCount.value < total;
  });

  /*
   * A tile reported in. The first load after a commit also retires the previous
   * set, which is what makes the cross-fade last a single tile fetch rather than
   * the whole generation.
   */
  function noteTileLoaded(key) {
    if (loadedKeys.has(key)) return;
    loadedKeys.add(key);
    loadedCount.value += 1;
    /*
     * Retire the outgoing layer only once the incoming set is complete.
     *
     * Retiring it on the first load - which is what this used to do - drops the
     * ground the map is standing on while most of the new tiles are still
     * missing, so a flight arrived at a half-drawn map.
     */
    if (previousLayer.value && !mapLoading.value) previousLayer.value = null;
  }

  /* Forgets which tiles have reported in, for when the whole set is replaced. */
  function resetLoadedTiles() {
    loadedKeys.clear();
    loadedCount.value = 0;
  }

  /* --- zoom commit -------------------------------------------------------- */

  /*
   * Re-commits the drawn tile set to the nearest whole zoom and clears the
   * pending-commit timer. This is the only moment the tile URLs change, which
   * is what keeps a pinch from re-fetching a full tile set per frame.
   */
  function commitTileZoom() {
    if (commitTimer) {
      globalThis.clearTimeout(commitTimer);
      commitTimer = 0;
    }
    const target = committedZoom(mapZoom.value);
    if (target !== tileZoom.value) {
      previousLayer.value = { tiles: mapTiles.value, tileZoom: tileZoom.value };
      tileZoom.value = target;
      resetLoadedTiles();
    }
  }

  function scheduleCommit() {
    if (commitTimer) globalThis.clearTimeout(commitTimer);
    commitTimer = globalThis.setTimeout(() => {
      commitTimer = 0;
      commitTileZoom();
    }, ZOOM_COMMIT_DELAY_MS);
  }

  /* --- panning and zooming ------------------------------------------------ */

  /*
   * Keeps the view inside the world.
   *
   * Longitude needs nothing: it wraps, so the map repeats forever. Latitude does
   * not - the world ends at the pole cut-off - so at high zoom a viewport centred
   * near the pole extends past the top or bottom of the world, where no rows
   * exist and the pane would show bare background. The centre is therefore pulled
   * back inside, or centred outright when the world is shorter than the viewport.
   */
  function clampCenterToWorld() {
    if (!(mapSize.value.width > 0) || !(mapSize.value.height > 0)) return;
    const world = TILE_SIZE * 2 ** mapZoom.value;
    const halfHeight = mapSize.value.height / 2;
    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      mapZoom.value,
    );
    const y =
      world <= mapSize.value.height
        ? world / 2
        : Math.min(world - halfHeight, Math.max(halfHeight, center.y));
    if (y !== center.y) {
      mapCenter.value = unprojectFromPixel(center.x, y, mapZoom.value);
    }
  }

  /*
   * Moves the centre by a *display* pixel delta. The delta is unprojected rather
   * than divided by a tile size, so panning tracks the cursor at every zoom
   * level instead of only at the one where a tile equals its pixel count.
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
    clampCenterToWorld();
  }

  /*
   * Zooms by a signed delta while keeping the geographic position under
   * (anchorX, anchorY) - the cursor, or the viewport centre for the buttons -
   * pinned in place.
   *
   * The anchor is unprojected at the old zoom, reprojected at the new one, and
   * then the centre is solved backwards from where that point must land. The
   * solve has to add half the viewport back, because a centre is measured from
   * the world's middle while the anchor is measured from the viewport's
   * top-left. With an unmeasured viewport the anchor collapses to the centre, so
   * the fallback is "zoom about the middle" rather than a jump to 0,0.
   */
  function zoomMap(delta, anchorX = null, anchorY = null) {
    const previous = mapZoom.value;
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(minViewZoom.value, clampZoom(previous + delta)),
    );
    if (nextZoom === previous) return;
    const targetX = anchorX ?? mapSize.value.width / 2;
    const targetY = anchorY ?? mapSize.value.height / 2;

    const center = projectToPixel(
      mapCenter.value.lon,
      mapCenter.value.lat,
      previous,
    );
    const anchorHere = unprojectFromPixel(
      center.x - mapSize.value.width / 2 + targetX,
      center.y - mapSize.value.height / 2 + targetY,
      previous,
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

    clampCenterToWorld();

    /* Commit immediately for a deliberate one-step change (a button or a mouse
       notch); let a continuous gesture run and commit when it settles. */
    if (Math.abs(delta) >= 1) commitTileZoom();
    else {
      if (Math.abs(mapZoom.value - tileZoom.value) >= ZOOM_COMMIT_THRESHOLD) {
        commitTileZoom();
      } else {
        scheduleCommit();
      }
    }
  }

  function zoomIn() {
    zoomMap(1);
  }

  function zoomOut() {
    zoomMap(-1);
  }

  /* --- inertia ------------------------------------------------------------ */

  function stopGlide() {
    if (glideHandle) {
      cancelFrame(glideHandle);
      glideHandle = 0;
    }
  }

  /*
   * Coasts the map after a flick, shedding speed every frame. The decay is a
   * per-millisecond factor rather than a fixed amount per frame, so the glide
   * lasts the same wall-clock time whatever the frame rate: without that, a slow
   * machine coasts further than a fast one.
   */
  function startGlide(velocityX, velocityY) {
    stopGlide();
    if (
      Math.abs(velocityX) < INERTIA_MIN_SPEED &&
      Math.abs(velocityY) < INERTIA_MIN_SPEED
    ) {
      return;
    }
    let last = now();
    const step = () => {
      const stamp = now();
      const elapsed = Math.min(64, Math.max(1, stamp - last));
      last = stamp;
      const decay = INERTIA_DECAY ** elapsed;
      velocityX *= decay;
      velocityY *= decay;
      const current = projectToPixel(
        mapCenter.value.lon,
        mapCenter.value.lat,
        mapZoom.value,
      );
      mapCenter.value = unprojectFromPixel(
        current.x - velocityX * elapsed,
        current.y - velocityY * elapsed,
        mapZoom.value,
      );
      clampCenterToWorld();
      if (
        Math.abs(velocityX) < INERTIA_MIN_SPEED &&
        Math.abs(velocityY) < INERTIA_MIN_SPEED
      ) {
        glideHandle = 0;
        return;
      }
      glideHandle = animate(step);
    };
    glideHandle = animate(step);
  }

  /* --- pointer interaction ------------------------------------------------ */

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
    /* A grab is a request to stop moving the map for them. */
    cancelFlight();
    stopGlide();
    dragStart = {
      pointerId: event.pointerId,
      /*
       * startX/startY never move: they are what the click-versus-drag test is
       * measured against. lastX/lastY is what the pan is measured against, and
       * lastTime feeds the flick velocity. Conflating the first two made every
       * drag look like a click that happened to end at the last move.
       */
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTime: now(),
      velocityX: 0,
      velocityY: 0,
    };
    mapPanning.value = false;
    mapElement.value?.setPointerCapture?.(event.pointerId);
  }

  function handleMapPointerMove(event) {
    /* The readout follows the pointer whether or not a drag is in progress. */
    if (mapShowCursor.value) {
      const at = locationFromEvent(event);
      mapCursorLocation.value = at
        ? { lat: at.lat, lon: at.lon, label: '' }
        : null;
    }
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragStart.lastX;
    const dy = event.clientY - dragStart.lastY;
    const stamp = now();
    const elapsed = Math.max(1, stamp - dragStart.lastTime);
    /* A smoothed velocity: the last sample alone is too noisy to throw with. */
    dragStart.velocityX = 0.7 * dragStart.velocityX + 0.3 * (dx / elapsed);
    dragStart.velocityY = 0.7 * dragStart.velocityY + 0.3 * (dy / elapsed);
    panMapByPixels(dx, dy);
    if (
      Math.hypot(
        event.clientX - dragStart.startX,
        event.clientY - dragStart.startY,
      ) > CLICK_SLOP_PX
    ) {
      mapPanning.value = true;
    }
    dragStart.lastX = event.clientX;
    dragStart.lastY = event.clientY;
    dragStart.lastTime = stamp;
  }

  /*
   * A drag that ends over a tiny movement is a click, not a pan, so only then
   * does the pin move. Without the threshold, every pan would also leave a pin
   * wherever the pointer happened to stop. A drag that did move is released with
   * its velocity, so a flick coasts.
   */
  function handleMapPointerUp(event) {
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    const moved = Math.hypot(
      event.clientX - dragStart.startX,
      event.clientY - dragStart.startY,
    );
    const wasDrag = moved > CLICK_SLOP_PX;
    const { velocityX, velocityY } = dragStart;
    mapElement.value?.releasePointerCapture?.(event.pointerId);
    dragStart = null;
    mapPanning.value = false;
    if (wasDrag) startGlide(velocityX, velocityY);
    else pickMapLocation(event);
  }

  function handleMapPointerCancel() {
    dragStart = null;
    mapPanning.value = false;
  }

  function handleMapPointerLeave() {
    mapCursorLocation.value = null;
  }

  /* --- view options -------------------------------------------------------- */

  function setMapFilter(name) {
    /* An unknown name would produce a class with no rules and a map that looks
       broken with no way back, so anything unrecognised resets to none. */
    mapFilter.value = MAP_FILTERS.includes(name) ? name : 'none';
  }

  function setMapRenderer(name) {
    const next = name === 'canvas' ? 'canvas' : 'dom';
    if (next === mapRenderer.value) return;
    mapRenderer.value = next;
    if (next === 'canvas') {
      /* The canvas has no bitmap until it is measured and sized. */
      measureMap();
      canvasRenderer.schedule();
    } else {
      /* Nothing is queued from here on; whatever frame is pending draws into a
         renderer that has been switched off and returns immediately. */
      canvasRenderer.schedule();
    }
  }

  function toggleMapSidebar() {
    mapSidebarOpen.value = !mapSidebarOpen.value;
  }

  function setMapShowGrid(value) {
    mapShowGrid.value = Boolean(value);
  }

  function setMapShowCursor(value) {
    mapShowCursor.value = Boolean(value);
    if (!value) mapCursorLocation.value = null;
  }

  /* Double click zooms in about the click, the way a map is expected to. */
  function handleMapDoubleClick(event) {
    event.preventDefault?.();
    cancelFlight();
    const element = mapElement.value;
    if (!element) return;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds) return;
    zoomMap(1, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  /*
   * The wheel is split by intent: a pinch or a mouse notch zooms about the
   * cursor, and a trackpad's two-finger scroll pans the map under it. Pinch
   * deltas arrive as ctrl+wheel and are already fractional, so they are scaled
   * down to a fraction of a zoom level each instead of stepping a whole level.
   */
  function handleMapWheel(event) {
    event.preventDefault?.();
    const element = mapElement.value;
    if (!element) return;
    cancelFlight();

    if (classifyWheel(event) === 'pan') {
      stopGlide();
      panMapByPixels(event.deltaX || 0, event.deltaY || 0);
      return;
    }
    const bounds = element.getBoundingClientRect?.();
    if (!bounds) return;
    /* A pinch reports ctrlKey and small deltas; a notch reports a large one. */
    const step = event.ctrlKey
      ? clampFraction(-event.deltaY / 240)
      : event.deltaY < 0
        ? 1
        : -1;
    zoomMap(step, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  /* Keeps a fractional step from becoming a wild jump on a spiky trackpad. */
  function clampFraction(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(0.4, Math.max(-0.4, value));
  }

  /* --- keyboard ----------------------------------------------------------- */

  /*
   * The canvas is focusable, so it must be drivable without a pointer. Arrows
   * pan, shift makes a long step, and +/- zoom about the centre. The status line
   * reports the coordinates so a keyboard user can still place a pin.
   */
  function handleMapKeydown(event) {
    const step = KEY_PAN_STEP_PX * (event.shiftKey ? KEY_LONG_STEP_FACTOR : 1);

    switch (event.key) {
      case 'ArrowLeft':
        panMapByPixels(step, 0);
        break;
      case 'ArrowRight':
        panMapByPixels(-step, 0);
        break;
      case 'ArrowUp':
        panMapByPixels(0, step);
        break;
      case 'ArrowDown':
        panMapByPixels(0, -step);
        break;
      case '+':
      case '=':
        zoomMap(1);
        break;
      case '-':
      case '_':
        zoomMap(-1);
        break;
      default:
        return;
    }
    event.preventDefault?.();
    /* Only a key the map actually used counts as taking over, so an unhandled
       key does not silently cancel a journey. */
    cancelFlight();
    reportViewCoordinates();
  }

  /* Announces where the centre is after a keyboard move. */
  function reportViewCoordinates() {
    setMapStatus(
      `Centre ${formatCoordinates({ lat: mapCenter.value.lat, lon: mapCenter.value.lon })} · ${mapZoomLabel.value}.`,
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
    /* The canvas backing store has to match the CSS size, or the tiles are
       stretched or cropped. */
    const canvas = theDoc()?.querySelector?.('#map-canvas-surface');
    if (canvas) {
      canvas.width = Math.floor(width * pixelRatio());
      canvas.height = Math.floor(height * pixelRatio());
    }
    resetLoadedTiles();
    canvasRenderer.prune();
    canvasRenderer.schedule();
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
    stopGlide();
    cancelFlight();
    canvasRenderer.dispose();
    if (commitTimer) globalThis.clearTimeout(commitTimer);
    commitTimer = 0;
    theDoc()?.defaultView?.removeEventListener?.('resize', handleWindowResize);
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
   * further out than the reader already was, and never below what the viewport
   * can actually cover.
   */
  function targetViewFor(location) {
    return {
      lat: location.lat,
      lon: location.lon,
      /*
       * Zoom *in* to 13 when the reader is further out than that, and never
       * further out than they already were. min() here would do the opposite and
       * pull a reader who is already at street level back to a continent.
       */
      zoom: Math.max(mapZoom.value, Math.min(13, MAX_ZOOM), minViewZoom.value),
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
    commitTileZoom();
    setMapStatus(
      pin.label
        ? `${pin.label} \u00b7 ${formatCoordinates(pin)}`
        : `Showing ${formatCoordinates(pin)}.`,
    );
  }

  /* Ends a journey. Only a journey that actually arrived moves the pin. */
  function finishFlight(landed) {
    if (!flight) return;
    cancelFrame(flight.handle);
    const arrived = flight.pin;
    flight = null;
    mapFlying.value = false;
    if (landed && arrived) arriveAt(arrived);
  }

  /*
   * Stops a journey where it is. The pin does not move: the reader took over, so
   * their intent is the last word, and a cancelled flight leaves the map where
   * they were rather than arriving somewhere they did not choose. The outgoing
   * tile layer stays until the current set has loaded, so even an interrupted
   * flight is standing on real ground.
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
    mapZoom.value = view.zoom;
    mapCenter.value = { lat: view.lat, lon: view.lon };
    clampCenterToWorld();
    /*
     * The same threshold a pinch uses. Committing here rather than once at the
     * end is what keeps the ground under the journey sharp: without it the
     * source tiles would be magnified by the whole zoom difference, which for a
     * jump from zoom 10 to 14 is sixteen times. The previous integer level stays
     * underneath as the backdrop, so the map is never blank mid-flight.
     */
    if (Math.abs(mapZoom.value - tileZoom.value) >= ZOOM_COMMIT_THRESHOLD) {
      commitTileZoom();
    }
    if (progress >= 1) {
      commitTileZoom();
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
    stopGlide();
    cancelFlight();

    const from = {
      lat: mapCenter.value.lat,
      lon: mapCenter.value.lon,
      zoom: mapZoom.value,
    };
    const to = targetViewFor(location);
    const settled =
      from.lat === to.lat && from.lon === to.lon && from.zoom === to.zoom;
    if (settled || duration <= 0 || reduceMotion()) {
      /* Still has to go there - arriving is not the same as being there. */
      mapCenter.value = { lat: to.lat, lon: to.lon };
      mapZoom.value = to.zoom;
      clampCenterToWorld();
      arriveAt(location);
      return true;
    }

    mapFlying.value = true;
    setMapStatus(
      location.label
        ? `Travelling to ${location.label}\u2026`
        : 'Travelling\u2026',
    );
    flight = { from, to, pin: location, started: now(), duration, handle: 0 };
    stepFlight();
    return true;
  }

  /*
   * Centres the map on a stored location and pins it. This is the immediate
   * jump: flyToLocation() is what a reader-initiated move should use, and this
   * is what the map does when there is nothing to animate or nothing to travel.
   */
  function showMapLocation(value) {
    const location = normalizeLocation(value);
    if (!location) {
      setMapStatus('That section has no saved location.', true);
      return false;
    }
    stopGlide();
    mapCenter.value = { lat: location.lat, lon: location.lon };
    clampCenterToWorld();
    mapPin.value = location;
    /* Jump in close enough to be useful, but never zoom *out* to get there, and
       never below what this viewport can actually cover. */
    if (mapZoom.value < 13) mapZoom.value = 13;
    mapZoom.value = Math.max(mapZoom.value, minViewZoom.value);
    commitTileZoom();
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
    tileZoom,
    mapSize,
    mapPin,
    mapPinOffset,
    mapStatus,
    mapStatusError,
    mapPanning,
    mapFlying,
    mapLoading,
    mapFilter,
    mapRenderer,
    mapShowGrid,
    mapShowCursor,
    mapSidebarOpen,
    mapCursorLocation,
    mapCanvasContext,
    mapTiles,
    previousLayer,
    previousTransform,
    mapTransform,
    mapScaleBar,
    mapZoomLabel,
    minViewZoom,
    mapBadge,
    tileSource,
    setMapStatus,
    noteTileLoaded,
    setMapFilter,
    setMapRenderer,
    toggleMapSidebar,
    setMapShowGrid,
    setMapShowCursor,
    placeMarkerOffset,
    canvasRenderer,
    mapFilters: MAP_FILTERS,
    createImage,
    commitTileZoom,
    panMapByPixels,
    zoomMap,
    zoomIn,
    zoomOut,
    locationFromEvent,
    pickMapLocation,
    showMapLocation,
    flyToLocation,
    cancelFlight,
    measureMap,
    startMapObserver,
    disposeMapExplorer,
    handleMapPointerDown,
    handleMapPointerMove,
    handleMapPointerUp,
    handleMapPointerCancel,
    handleMapDoubleClick,
    handleMapWheel,
    handleMapKeydown,
    handleMapPointerLeave,
    handleWindowResize,
  };
}

/* The app's single map explorer session, like every other tool. */
const session = createMapExplorer();

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
export const previousLayer = session.previousLayer;
export const previousTransform = session.previousTransform;
export const mapTransform = session.mapTransform;
export const mapScaleBar = session.mapScaleBar;
export const mapZoomLabel = session.mapZoomLabel;
export const minViewZoom = session.minViewZoom;
export const mapBadge = session.mapBadge;
export const tileSource = session.tileSource;
export const setMapStatus = session.setMapStatus;
export const noteTileLoaded = session.noteTileLoaded;
export const setMapFilter = session.setMapFilter;
export const setMapRenderer = session.setMapRenderer;
export const toggleMapSidebar = session.toggleMapSidebar;
export const setMapShowGrid = session.setMapShowGrid;
export const setMapShowCursor = session.setMapShowCursor;
export const placeMarkerOffset = session.placeMarkerOffset;
export const canvasRenderer = session.canvasRenderer;
export const commitTileZoom = session.commitTileZoom;
export const panMapByPixels = session.panMapByPixels;
export const zoomMap = session.zoomMap;
export const zoomIn = session.zoomIn;
export const zoomOut = session.zoomOut;
export const locationFromEvent = session.locationFromEvent;
export const pickMapLocation = session.pickMapLocation;
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
export const handleMapPointerLeave = session.handleMapPointerLeave;
export const handleMapDoubleClick = session.handleMapDoubleClick;
export const handleMapWheel = session.handleMapWheel;
export const handleMapKeydown = session.handleMapKeydown;
export const handleWindowResize = session.handleWindowResize;
