/*
 * Fixtures shared by the map's test files.
 *
 * These were three helpers inside one 1500-line test file. Splitting the file
 * along the module boundaries - projection, viewport, Explorer - meant all three
 * needed `close`, and two needed the session builders, so copying them would have
 * put three copies of a tolerance assertion in the tree to drift apart.
 */
import assert from 'node:assert/strict';

import { createMapExplorer } from '../../src/map-explorer.js';

/**
 * Asserts a computed number is within a tolerance of an expected one.
 *
 * The map's math is approximate by nature - a Mercator projection, a haversine on
 * a sphere - so the tests pin a figure rather than an exact equality, and this is
 * where the tolerance and the failure message live. The message says which value
 * was expected because "expected 0, got NaN" in a suite of a hundred cases does not
 * say which assertion failed.
 */
export const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ~${expected}, got ${actual}`,
  );

export function readyExplorer(options = {}) {
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    ...options,
  });
  explorer.mapSize.value = { width: 512, height: 512 };
  explorer.mapElement.value = {
    clientWidth: 512,
    clientHeight: 512,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  return explorer;
}

export function flyingExplorer(options = {}) {
  let clock = 0;
  const frames = [];
  const explorer = createMapExplorer({
    initialCenter: { lat: 0, lon: 0 },
    initialZoom: 4,
    now: () => clock,
    animate: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelFrame: () => {},
    ...options,
  });
  explorer.mapSize.value = { width: 400, height: 300 };
  explorer.mapElement.value = {
    clientWidth: 400,
    clientHeight: 300,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  /* Advances the clock and runs every frame the session asked for, including
     frames queued while stepping. */
  const advance = (ms) => {
    clock += ms;
    let guard = 0;
    while (frames.length > 0 && guard < 200) {
      frames.shift()();
      guard += 1;
    }
  };
  return { explorer, advance, frames };
}
