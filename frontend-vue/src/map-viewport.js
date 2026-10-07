/*
 * The map viewport: everything two tiled maps share.
 *
 * The Explorer and the Google viewer were two near-copies of the same ~480 lines -
 * pan, zoom, inertia, the pointer and keyboard handlers, measurement, the resize
 * observer, and the tile rate floor - which had already drifted. The rate floor
 * was the clearest symptom: it was added to one session and documented as
 * applying to both, and the only reason the other did not have it was that
 * nobody copied it. Documentation that describes two code paths and only one of
 * them is a lie waiting to be believed.
 *
 * So the shared half lives here and each session is what makes it *its* map: the
 * Explorer adds pins, saved places, the colour filters, flights, and GeoJSON; the
 * Google viewer adds its layer selector, URL parsing, and GeoJSON export.
 *
 * --- What a session has to supply -------------------------------------------
 *
 * Three optional hooks, because three behaviours are genuinely different between
 * the two rather than accidentally so:
 *
 *   onClick(location, event)    a click that was not a drag. The Explorer drops a
 *                              pin; the Google viewer has no pins and ignores it.
 *   onMove(location)            where the pointer is. Both report it; it is a hook
 *                              because what is done with it is per-session.
 *   onInterrupt()               a grab, wheel, or key means "stop moving the map
 *                              for me". The Explorer cancels a flight in
 *                              progress; the Google viewer has nothing to cancel.
 *   onViewMoved(location)       after a keyboard move, so a keyboard user learns
 *                              where they are. Wording is per-session.
 *
 * A hook left out is not an error. That is what lets the Google viewer be a
 * render-only map without a set of `if (hasPins)` branches threaded through the
 * gesture code.
 */
import { computed, ref, watch } from 'vue';

import { clampLatitude, wrapLongitude } from './geo.js';
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
 * How long after the last zoom event before a pinch is committed.
 *
 * The commit threshold lives in map-projection.js's caller, not here, because it
 * is a tuning pair with the gesture vocabulary; both sessions passed the same
 * value, so it moved here and is re-exported for the tests that pin it.
 */
export const ZOOM_COMMIT_DELAY_MS = 160;

/*
 * How far a pinch may drift from the committed integer zoom before the tile set is
 * re-committed. Smaller values keep the tiles sharper but fetch more often; 0.5
 * caps the transient blur at about 1.4x, which reads as smooth rather than soft.
 */
export const ZOOM_COMMIT_THRESHOLD = 0.5;

/* The minimum interval between two tile requests, and how many may start at once.
   See docs/map-sources.md for the policy this serves. */
export const DEFAULT_RATE_FLOOR_MS = 200;
export const TILE_BURST = 8;

/*
 * A 1x1 transparent GIF: what a tile looks like before the rate floor admits it.
 * Present because a tile still holds its place in the layer while it waits - the
 * alternative, not mounting it, moves the ground around the hole.
 */
const PENDING_TILE_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function createMapViewport({
  doc = null,
  tileUrl,
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
  renderer = 'dom',
  showGrid = false,
  showCursor = true,
  /* The three hooks. All optional; see the note at the top of the file. */
  onClick = null,
  onMove = null,
  onInterrupt = null,
  onViewMoved = null,
  /* Extra shapes the canvas should draw, for a session that has an overlay. */
  getShapes = null,
  /*
   * The <canvas> to size when measuring. The two viewers each have their own and
   * neither shares a DOM id, so the session names its own; it is a selector rather
   * than a reference because the element does not exist yet at construction time.
   */
  canvasSelector = '#map-canvas-surface',
} = {}) {
  const theDoc = () => doc ?? globalThis.document;

  const mapElement = ref(null);
  const mapCanvasContext = ref(null);
  /*
   * Backing-store ratio for the canvas renderer. Tiles are 256 CSS pixels and the
   * public tile servers have no retina variant, so rendering above 1x only makes
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
  const mapPanning = ref(false);
  /* True while the view is travelling under its own power - a flight, for the
     Explorer. Nothing else sets it, so the Google viewer simply leaves it false. */
  const mapFlying = ref(false);
  /* Where the pointer is, as a coordinate, for the readout under the cursor. */
  const mapCursorLocation = ref(null);

  const mapRenderer = ref(renderer === 'canvas' ? 'canvas' : 'dom');
  const mapShowGrid = ref(Boolean(showGrid));
  const mapShowCursor = ref(showCursor !== false);

  let dragStart = null;
  let observer = null;
  let commitTimer = 0;
  let glideHandle = 0;
  /* Keys of tiles in the current set that have reported in. Reset whenever the
     set changes, so a late load from the previous set cannot make a fresh one
     look ready. */
  const loadedKeys = new Set();
  const loadedCount = ref(0);

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

  /* The tiles covering the viewport at the committed zoom, plus a ring. This is
     every tile the view *wants*; admission is a separate step below. */
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

  /* The tiles the rate floor has let through - what the DOM layer mounts. */
  const mapAdmittedTiles = computed(() =>
    mapTiles.value.filter((tile) => admittedKeys.value.has(tile.key)),
  );

  /*
   * The outgoing tile set, kept mounted while the incoming one fetches so a zoom
   * commit or a flight fades over ground that is already there instead of flashing
   * the background.
   *
   * It stores the tile zoom it was fetched at, and its transform is derived live
   * from the current view. A captured transform would freeze the outgoing tiles at
   * the position they had when the commit happened, so they would sit visibly
   * misaligned for as long as they were on screen - and during a flight, which
   * animates the view, that would be the whole journey.
   */
  const previousLayer = ref(null);

  /* The outgoing layer's transform, recomputed every frame from the live view.
     Same formula as the main layer, so the two line up exactly. */
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

  /* --- the canvas renderer ------------------------------------------------- */

  const canvasRenderer = createCanvasRenderer({
    /* Only admitted tiles. A pending tile would otherwise get an Image whose src
       is the transparent pixel, which costs a decode and a cache entry per
       outstanding tile for no picture. */
    getTiles: () => mapAdmittedTiles.value,
    getTransform: () => mapTransform.value,
    getSize: () => mapSize.value,
    isEnabled: () => mapRenderer.value === 'canvas',
    tileSource,
    getContext: () => mapCanvasContext.value,
    getShapes,
    getTileZoom: () => tileZoom.value,
    createImage,
    animate,
    cancelFrame,
    pixelRatio,
    tileSize,
  });

  /* --- the rate floor ------------------------------------------------------ */

  /*
   * A ref of a Set rather than a plain one: Vue wraps a ref'd collection in a
   * reactive proxy that traps add(), so adding a key is what re-runs the
   * templates and the canvas frame that read tileSource(). A bare Set mutated in
   * place would change the URLs without redrawing anything.
   */
  const admittedKeys = ref(new Set());
  /*
   * `null` rather than a number while the floor is disabled: a zero floor means no
   * ceiling, and a bucket of TILE_BURST would quietly reintroduce the limit that
   * was just turned off.
   */
  let burstTokens = rateFloorMs <= 0 ? null : TILE_BURST;
  /*
   * null rather than 0: an injected clock in tests legitimately starts at 0, and a
   * 0 sentinel there would read as "never refilled" forever and hand out a
   * permanent full bucket.
   */
  let lastRefill = null;
  let admitTimer = 0;

  function refillTokens(stamp) {
    if (rateFloorMs <= 0) {
      burstTokens = null;
      return;
    }
    if (lastRefill === null) {
      lastRefill = stamp;
      return;
    }
    const earned = Math.floor((stamp - lastRefill) / rateFloorMs);
    if (earned <= 0) return;
    burstTokens = Math.min(TILE_BURST, (burstTokens ?? 0) + earned);
    lastRefill += earned * rateFloorMs;
  }

  /* How long until the next slot opens, or 0 if one is already available. */
  function millisUntilNextSlot(stamp) {
    if (rateFloorMs <= 0) return 0;
    if (burstTokens === null || burstTokens > 0) return 0;
    return Math.max(0, rateFloorMs - (stamp - lastRefill));
  }

  function tileSource(tile) {
    if (!admittedKeys.value.has(tile.key)) return PENDING_TILE_SRC;
    return tileUrl(tile.z, tile.x, tile.y, tileSize);
  }

  function isTileAdmitted(tile) {
    return admittedKeys.value.has(tile.key);
  }

  /*
   * Admits as many outstanding tiles as the bucket allows and, if any are left
   * over, schedules itself for the moment the next slot opens. Tiles are admitted
   * centre-outward: the middle of the screen is what the reader is looking at, and
   * the buffer ring exists to cover a pan that may never happen.
   */
  function admitTiles() {
    const stamp = now();
    refillTokens(stamp);
    const outstanding = mapTiles.value.filter(
      (tile) => !admittedKeys.value.has(tile.key),
    );
    if (!outstanding.length) {
      cancelAdmitTimer();
      return;
    }
    const ordered = orderByDistanceFromCenter(outstanding);
    let admitted = 0;
    for (const tile of ordered) {
      if (burstTokens !== null) {
        if (burstTokens <= 0) break;
        burstTokens -= 1;
      }
      admittedKeys.value.add(tile.key);
      admitted += 1;
    }
    if (ordered.length > admitted) {
      scheduleAdmit(millisUntilNextSlot(stamp));
    } else {
      cancelAdmitTimer();
    }
  }

  function scheduleAdmit(delay) {
    cancelAdmitTimer();
    admitTimer = globalThis.setTimeout(() => {
      admitTimer = 0;
      admitTiles();
    }, delay);
    /*
     * A pending admission must not be the reason a process stays alive. In a
     * browser the handle is a number and this is a no-op; in node it is a Timeout
     * with unref(), and without it a test run waits out the whole drain.
     */
    admitTimer?.unref?.();
  }

  function cancelAdmitTimer() {
    if (!admitTimer) return;
    globalThis.clearTimeout(admitTimer);
    admitTimer = 0;
  }

  /*
   * Admission follows the tile set rather than being called by each place the set
   * can change. Every caller that had to remember - a zoom commit, a resize, the
   * first measurement - is a way to miss it, and a missed admission is a map that
   * never draws rather than an error anyone would notice. `sync` because the tiles
   * have to be admitted in the same tick that produced them: waiting for the
   * scheduler would leave the first paint blank.
   */
  const stopAdmitWatch = watch(mapTiles, admitTiles, {
    immediate: true,
    flush: 'sync',
  });

  /* Sorts tiles by how far they sit from the middle of the viewport, in tile
     units. Pure and static so it can be pinned by a test without a session. */
  function orderByDistanceFromCenter(tiles) {
    const span = 2 ** tileZoom.value;
    const half = span / 2;
    return [...tiles].sort((a, b) => {
      const ax = Math.abs(a.x + 0.5 - half);
      const ay = Math.abs(a.y + 0.5 - half);
      const bx = Math.abs(b.x + 0.5 - half);
      const by = Math.abs(b.y + 0.5 - half);
      return ax * ax + ay * ay - (bx * bx + by * by);
    });
  }

  /* --- tile loading -------------------------------------------------------- */

  /*
   * Derived, not stored: a loading flag that has to be poked by hand goes stale
   * the moment the tile set changes for any other reason. Comparing a live count
   * against a live total cannot.
   *
   * Measured against the *wanted* set, not the admitted one. Only admitted tiles
   * are mounted and so only they ever report in, which means this stays true while
   * the rate floor is still handing out slots - correctly, because the screen is
   * not drawn yet. Measuring it against the admitted set instead would let it go
   * false with half the screen still queued, and the caller that cares (the
   * previous-layer retirement below) would retire the backdrop under a half-drawn
   * map.
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
     * Retire the outgoing layer only once the incoming set is complete. Retiring
     * it on the first load drops the ground the map is standing on while most of
     * the new tiles are still missing, so a flight arrives at a half-drawn map.
     */
    if (previousLayer.value && !mapLoading.value) previousLayer.value = null;
  }

  /* Forgets which tiles have reported in, for when the whole set is replaced. */
  function resetLoadedTiles() {
    loadedKeys.clear();
    loadedCount.value = 0;
  }

  /* --- zoom commit --------------------------------------------------------- */

  /*
   * Re-commits the drawn tile set to the nearest whole zoom and clears the
   * pending-commit timer. This is the only moment the tile URLs change, which is
   * what keeps a pinch from re-fetching a full tile set per frame.
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

  /* --- panning and zooming ------------------------------------------------- */

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
   * than divided by a tile size, so panning tracks the cursor at every zoom level
   * instead of only at the one where a tile equals its pixel count.
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
   * the world's middle while the anchor is measured from the viewport's top-left.
   * With an unmeasured viewport the anchor collapses to the centre, so the
   * fallback is "zoom about the middle" rather than a jump to 0,0.
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
    else if (
      Math.abs(mapZoom.value - tileZoom.value) >= ZOOM_COMMIT_THRESHOLD
    ) {
      commitTileZoom();
    } else {
      scheduleCommit();
    }
  }

  function zoomIn() {
    zoomMap(1);
  }

  function zoomOut() {
    zoomMap(-1);
  }

  /* --- inertia ------------------------------------------------------------- */

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

  function handleMapPointerDown(event) {
    if (event.button !== 0) return;
    /* A grab is a request to stop moving the map for them. */
    onInterrupt?.();
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
      const here = at ? { lat: at.lat, lon: at.lon, label: '' } : null;
      mapCursorLocation.value = here;
      onMove?.(here);
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
   * A drag that ends over a tiny movement is a click, not a pan, so only then is
   * a click reported. Without the threshold, every pan would also drop a pin
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
    else onClick?.(locationFromEvent(event), event);
  }

  function handleMapPointerCancel() {
    dragStart = null;
    mapPanning.value = false;
  }

  function handleMapPointerLeave() {
    mapCursorLocation.value = null;
  }

  /* Double click zooms in about the click, the way a map is expected to. */
  function handleMapDoubleClick(event) {
    event.preventDefault?.();
    onInterrupt?.();
    const element = mapElement.value;
    if (!element) return;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds) return;
    zoomMap(1, event.clientX - bounds.left, event.clientY - bounds.top);
  }

  /*
   * The wheel is split by intent: a pinch or a mouse notch zooms about the
   * cursor, and a trackpad's two-finger scroll pans the map under it. Pinch deltas
   * arrive as ctrl+wheel and are already fractional, so they are scaled and
   * clamped; a notch is a whole step either way.
   */
  function handleMapWheel(event) {
    event.preventDefault?.();
    const element = mapElement.value;
    if (!element) return;
    onInterrupt?.();

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

  /* --- keyboard ------------------------------------------------------------ */

  /*
   * The canvas is focusable, so it must be drivable without a pointer. Arrows pan,
   * shift makes a long step, and +/- zoom about the centre. The status line
   * reports the coordinates so a keyboard user can still find their way.
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
    /* Only a key the map actually used counts as taking over, so an unhandled key
       does not silently cancel a journey. */
    onInterrupt?.();
    onViewMoved?.({
      lat: mapCenter.value.lat,
      lon: mapCenter.value.lon,
      label: '',
    });
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
    const canvas = theDoc()?.querySelector?.(canvasSelector);
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

  /* Releases only what the viewport owns. A session disposes its own extras and
     then calls this, so the order of teardown stays the session's decision. */
  function disposeViewport() {
    observer?.disconnect();
    observer = null;
    dragStart = null;
    stopGlide();
    canvasRenderer.dispose();
    if (commitTimer) globalThis.clearTimeout(commitTimer);
    commitTimer = 0;
    stopAdmitWatch();
    cancelAdmitTimer();
    admittedKeys.value.clear();
    theDoc()?.defaultView?.removeEventListener?.('resize', handleWindowResize);
  }

  /* --- view options -------------------------------------------------------- */

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

  function setMapShowGrid(value) {
    mapShowGrid.value = Boolean(value);
  }

  function setMapShowCursor(value) {
    mapShowCursor.value = Boolean(value);
    if (!value) mapCursorLocation.value = null;
  }

  return {
    /* state */
    mapElement,
    mapCanvasContext,
    mapCenter,
    mapZoom,
    tileZoom,
    mapSize,
    mapPanning,
    mapFlying,
    mapCursorLocation,
    mapRenderer,
    mapShowGrid,
    mapShowCursor,
    /* derived */
    mapTransform,
    mapTiles,
    mapAdmittedTiles,
    previousLayer,
    previousTransform,
    mapScaleBar,
    minViewZoom,
    mapZoomLabel,
    canvasRenderer,
    /* tiles */
    tileSource,
    isTileAdmitted,
    admitTiles,
    admittedTileCount: () => admittedKeys.value.size,
    pendingTileCount: () =>
      mapTiles.value.filter((tile) => !admittedKeys.value.has(tile.key)).length,
    burstTokens: () => burstTokens,
    rateFloorMs: () => rateFloorMs,
    noteTileLoaded,
    resetLoadedTiles,
    mapLoading,
    /* view */
    commitTileZoom,
    scheduleCommit,
    clampCenterToWorld,
    panMapByPixels,
    zoomMap,
    zoomIn,
    zoomOut,
    stopGlide,
    startGlide,
    mapOrigin,
    locationFromEvent,
    /* input */
    handleMapPointerDown,
    handleMapPointerMove,
    handleMapPointerUp,
    handleMapPointerCancel,
    handleMapPointerLeave,
    handleMapDoubleClick,
    handleMapWheel,
    handleMapKeydown,
    /* measurement */
    measureMap,
    handleWindowResize,
    startMapObserver,
    disposeViewport,
    /* options */
    setMapRenderer,
    setMapShowGrid,
    setMapShowCursor,
  };
}
