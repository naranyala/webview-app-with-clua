/*
 * What the user's gestures mean.
 *
 * The wheel alone is ambiguous: a trackpad's two-finger scroll and a mouse's
 * notched wheel both arrive as small and large pixel deltas, but the reader
 * expects one to pan and the other to zoom, and a browser reports a pinch as
 * ctrl+wheel. Deciding that from the event's shape is pure, so it lives here and
 * is tested without a session.
 *
 * The click-versus-drag threshold and the flick physics live here too, since
 * they are properties of the input rather than of the view.
 */

/*
 * Wheel deltas larger than this (in CSS pixels) are a mouse notch rather than a
 * trackpad's continuous scroll. A notched wheel zooms; a trackpad's two-finger
 * scroll pans, because a pinch already arrives as ctrl+wheel and zooming on
 * every small delta is what made the map feel like it was fighting the user.
 */
export const TRACKPAD_MAX_DELTA = 40;

/*
 * How far a pointer may travel between press and release and still count as a
 * click rather than a pan. A few pixels of jitter is normal on a trackpad or a
 * touchscreen, and dropping a pin on every such wobble would be worse than the
 * occasional missed click.
 */
export const CLICK_SLOP_PX = 4;

/* Panning speeds below this (CSS px per millisecond) end the inertia glide. */
export const INERTIA_MIN_SPEED = 0.02;

/* How quickly inertia sheds speed, as a fraction retained per millisecond. */
export const INERTIA_DECAY = 0.94;

/*
 * One arrow-key pan, and how much a long step multiplies it. Held down, the key
 * repeats and the map walks; shift is the long way.
 */
export const KEY_PAN_STEP_PX = 64;
export const KEY_LONG_STEP_FACTOR = 4;

/*
 * Decides what a wheel event means, from its shape alone.
 *
 *   - ctrl/cmd is how a browser reports a trackpad pinch, so it always zooms.
 *   - shift is the conventional horizontal pan modifier.
 *   - a non-pixel deltaMode means line or page steps, which only a notched wheel
 *     sends, so it zooms.
 *   - a large pixel delta is a mouse notch, which zooms.
 *   - anything small and pixel-valued is a trackpad's two-finger scroll, which
 *     pans. Zooming on those is what made panning feel impossible.
 *
 * Returns 'zoom' or 'pan'; the caller applies the event's own deltas.
 */
export function classifyWheel({
  deltaY = 0,
  deltaMode = 0,
  ctrlKey = false,
  shiftKey = false,
} = {}) {
  if (ctrlKey) return 'zoom';
  if (shiftKey) return 'pan';
  if (deltaMode !== 0) return 'zoom';
  if (Math.abs(deltaY) >= TRACKPAD_MAX_DELTA) return 'zoom';
  return 'pan';
}
