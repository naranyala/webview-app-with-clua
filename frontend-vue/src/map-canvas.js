/*
 * The canvas tile renderer.
 *
 * The DOM renderer is a few dozen <img> elements; this is one. The tradeoff is
 * real: the canvas needs its images decoded and drawn by hand and repainted on a
 * frame, while the DOM version lets the browser do that work, but it removes
 * every tile from the layout tree, which is what a slow pan pays for. It is
 * offered as an option rather than a replacement.
 *
 * It is separate from the session because it is a renderer, not a view model: it
 * is handed the state it needs through a small accessor bundle and owns only the
 * bitmap cache and the frame handle. That also makes it testable against a plain
 * object, with no Vue and no browser.
 */

/*
 * `source` supplies the view, as functions rather than values, because every one
 * of them changes while a gesture is running:
 *
 *   getTiles()      the tiles covering the viewport, with their absolute positions
 *   getTransform()  the layer transform the DOM path would apply
 *   getSize()       the measured viewport
 *   isEnabled()     false in DOM mode, where this renderer must do nothing
 *   tileSource()    the URL for a tile
 *   getContext()    the 2D context, or null before the canvas is laid out
 *
 * `createImage` and the scheduler are injected so the whole thing runs in node,
 * which has neither an Image constructor nor requestAnimationFrame.
 */
export function createCanvasRenderer({
  getTiles,
  getTransform,
  getSize,
  isEnabled,
  tileSource,
  getContext,
  createImage = () => new globalThis.Image(),
  animate = (fn) =>
    globalThis.requestAnimationFrame?.(fn) ?? setTimeout(fn, 16),
  cancelFrame = (handle) =>
    globalThis.cancelAnimationFrame?.(handle) ?? clearTimeout(handle),
  pixelRatio = () => 1,
  tileSize = 256,
} = {}) {
  /*
   * Decoded bitmaps, keyed by tile key. Tiles that leave the buffered set are
   * dropped, so the cache stays around a viewport's worth rather than growing
   * for the whole session.
   */
  const images = new Map();
  let frame = 0;

  /*
   * The bitmap for a tile, starting its load if this is the first time it has
   * been asked for. A load failure is remembered as null: a tile that 404s stays
   * a hole, and re-requesting it every frame would turn one missing tile into a
   * request per frame. The loading indicator is what reports it to the reader.
   */
  function imageFor(tile) {
    const cached = images.get(tile.key);
    if (cached !== undefined) return cached;
    const image = createImage();
    image.decoding = 'async';
    image.onload = () => schedule();
    image.onerror = () => {
      images.set(tile.key, null);
      schedule();
    };
    image.src = tileSource(tile);
    images.set(tile.key, image);
    return image;
  }

  /* Drops the bitmaps for tiles that are no longer on screen or nearby. */
  function prune() {
    const tiles = getTiles();
    if (images.size <= tiles.length * 2) return;
    const live = new Set(tiles.map((tile) => tile.key));
    for (const key of [...images.keys()]) {
      if (!live.has(key)) images.delete(key);
    }
  }

  /*
   * Repaints on the next frame. One handle for a burst of state changes, so a
   * drag that moves the centre ten times draws once rather than ten times.
   */
  function schedule() {
    if (!isEnabled() || frame) return;
    frame = animate(() => {
      frame = 0;
      draw();
    });
  }

  /*
   * Draws the visible tiles.
   *
   * setTransform does the placement: the context is put into layer coordinates
   * once, so each tile is drawn at its own absolute world position and the same
   * layerTransform() the DOM path uses does the rest. A per-tile matrix change
   * would defeat that.
   */
  function draw(context = getContext()) {
    if (!context) return;
    const { width, height } = getSize();
    if (!(width > 0) || !(height > 0)) return;
    const ratio = pixelRatio();
    const tiles = getTiles();

    /* Clear in device space: the previous frame left a scale on, and clearing
       under it would only wipe part of the canvas. */
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);

    const transform = getTransform();
    context.setTransform(
      transform.scale * ratio,
      0,
      0,
      transform.scale * ratio,
      transform.x * ratio,
      transform.y * ratio,
    );
    for (const tile of tiles) {
      const image = imageFor(tile);
      /* null marks a tile that failed to load; an incomplete image has nothing
         to draw yet. */
      if (image?.complete !== true || image.naturalWidth === 0) continue;
      context.drawImage(image, tile.left, tile.top, tileSize, tileSize);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* Releases the cache and abandons a pending frame. */
  function dispose() {
    if (frame) cancelFrame(frame);
    frame = 0;
    images.clear();
  }

  return {
    draw,
    schedule,
    prune,
    imageFor,
    dispose,
    imageCount: () => images.size,
  };
}
