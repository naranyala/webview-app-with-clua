/*
 * Measuring between two points, and locating the reader.
 *
 * Both are cases where the arithmetic or the failure mode is the feature, so the
 * numbers are pinned against known values rather than against the formulas: a
 * distance that is subtly wrong everywhere is not noticeable until someone flies
 * with the answer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bearingDegrees,
  clampLatitude,
  compassPoint,
  distanceMeters,
  formatCoordinates,
  formatDistance,
  formatDistanceImperial,
  MAX_LATITUDE,
  normalizeLocation,
  wrapLongitude,
} from '../src/geo.js';
import {
  describeLocate,
  LOCATE_DENIED,
  LOCATE_TIMEOUT,
  LOCATE_UNAVAILABLE,
  locateViaBrowser,
} from '../src/map-locate.js';

/* --- known distances ------------------------------------------------------- */

test('distance matches published great-circle figures', () => {
  /*
   * Reference values, to 0.5%. Anything within this band is right for the model
   * the app uses; the residual is the difference between a sphere and the WLS-84
   * ellipsoid, which is documented in geo.js and not papered over here.
   */
  const cases = [
    /* London to Paris, ~343 km */
    [{ lat: 51.5007, lon: -0.1246 }, { lat: 48.8566, lon: 2.3522 }, 343_500],
    /* New York to Los Angeles, ~3936 km */
    [
      { lat: 40.7128, lon: -74.006 },
      { lat: 34.0522, lon: -118.2437 },
      3_935_746,
    ],
    /*
     * One degree of latitude: 111,195 m on a sphere of this radius. Worth being
     * explicit that this is the *spherical* figure and not the ~110,574 m of the
     * WGS-84 ellipsoid - the difference is the 0.5% the model gives up, and using
     * the ellipsoid number here would have been a plausible-looking wrong
     * reference rather than a useful one.
     */
    [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, 111_195],
    /* Pole to pole, half the circumference, ~20,015 km */
    [{ lat: -90, lon: 0 }, { lat: 90, lon: 0 }, 20_015_114],
  ];

  for (const [from, to, expected] of cases) {
    const meters = distanceMeters(from, to);
    assert.ok(
      Math.abs(meters - expected) / expected < 0.005,
      `${JSON.stringify(from)} to ${JSON.stringify(to)}: got ${meters}, expected about ${expected}`,
    );
  }
});

test('a short distance stays accurate, which is the case that matters', () => {
  /*
   * Two pins a few streets apart. The spherical law of cosines is the usual
   * alternative and is exactly where it falls apart - acos of a number very close
   * to 1 throws away most of the digits. This asserts the short case separately
   * from the long ones for that reason.
   */
  const meters = distanceMeters(
    { lat: 51.5007, lon: -0.1246 },
    { lat: 51.5018, lon: -0.1246 },
  );
  /* 0.0011 degrees of latitude is about 122 m. */
  assert.ok(
    Math.abs(meters - 122.3) < 1,
    `got ${meters}, expected about 122 m`,
  );
});

test('the antipodal case is finite rather than NaN', () => {
  /*
   * The one input where sin^2 comes back marginally above 1 on floating point, so
   * asin would be handed something out of its domain. A NaN distance here would
   * surface as a blank readout rather than as an error.
   */
  const meters = distanceMeters(
    { lat: 0, lon: 0 },
    { lat: 0, lon: 179.9999999 },
  );
  assert.ok(Number.isFinite(meters), 'a finite number');
  assert.ok(
    Math.abs(meters - 20_015_114) < 100,
    `close to half the circumference, got ${meters}`,
  );
});

test('an out-of-range coordinate is refused rather than clamped into range', () => {
  /*
   * The antipodal case has to be expressed with a longitude the validator accepts:
   * 180.0000001 is out of range, and normalizeLocation rejects it rather than
   * wrapping or clamping it - so this asserts the rejection is what happens rather
   * than quietly feeding the arithmetic a value that never gets there.
   */
  assert.equal(
    distanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 180.0000001 }),
    null,
    'a longitude past the antimeridian is a broken record, not half a planet away',
  );
});

test('distance across the antimeridian is the short way round', () => {
  /* Two points either side of the seam. Wrapping the difference the naive way
     would report going the long way round the planet. */
  const meters = distanceMeters(
    { lat: 0, lon: 179.9 },
    { lat: 0, lon: -179.9 },
  );
  assert.ok(meters < 25_000, `expected about 22 km, got ${meters}`);
});

test('a point has no distance from an unusable one', () => {
  assert.equal(distanceMeters({ lat: 0, lon: 0 }, null), null);
  assert.equal(distanceMeters(null, { lat: 0, lon: 0 }), null);
  assert.equal(distanceMeters({ lat: 999, lon: 0 }, { lat: 0, lon: 0 }), null);
  assert.equal(distanceMeters({ lat: 'x', lon: 0 }, { lat: 0, lon: 0 }), null);
});

test('a point is zero from itself', () => {
  assert.equal(
    distanceMeters({ lat: 51.5, lon: -0.12 }, { lat: 51.5, lon: -0.12 }),
    0,
  );
});

/* --- bearings -------------------------------------------------------------- */

test('bearing points the four compass ways', () => {
  const cases = [
    [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, 0, 'north'],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, 90, 'east'],
    [{ lat: 1, lon: 0 }, { lat: 0, lon: 0 }, 180, 'south'],
    [{ lat: 0, lon: 1 }, { lat: 0, lon: 0 }, 270, 'west'],
  ];
  for (const [from, to, expected, name] of cases) {
    const bearing = bearingDegrees(from, to);
    assert.ok(
      Math.abs(bearing - expected) < 0.01,
      `${name}: got ${bearing}, expected ${expected}`,
    );
  }
});

test('bearing across the antimeridian goes east, not west', () => {
  /*
   * The specific case worth a test. 179.9E to 179.95W is a short hop east; a
   * naive longitude difference is -359.85 degrees, which sends the reader west
   * around the planet.
   */
  const bearing = bearingDegrees(
    { lat: 0, lon: 179.9 },
    { lat: 0, lon: -179.95 },
  );
  assert.ok(
    bearing > 88 && bearing < 92,
    `expected roughly east, got ${bearing}`,
  );
});

test('bearing is always in [0, 360)', () => {
  for (const [from, to] of [
    [
      { lat: -90, lon: 0 },
      { lat: 90, lon: 179 },
    ],
    [
      { lat: 89, lon: -179 },
      { lat: -89, lon: 179 },
    ],
    [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0 },
    ],
  ]) {
    const bearing = bearingDegrees(from, to);
    assert.ok(bearing >= 0 && bearing < 360, `got ${bearing}`);
  }
});

test('bearing from an unusable point is null', () => {
  assert.equal(bearingDegrees({ lat: 0, lon: 0 }, { lat: 500, lon: 0 }), null);
});

/* --- formatting ------------------------------------------------------------ */

test('distance formatting switches unit at a readable place', () => {
  assert.equal(formatDistance(0.4), '40 cm');
  assert.equal(formatDistance(12.4), '12 m');
  /* One decimal below 10 km, none above: 1.2 km is more use than 1.24 km. */
  assert.equal(formatDistance(1240), '1.2 km');
  assert.equal(formatDistance(24_600), '25 km');
});

test('imperial distance sits beside the metric one', () => {
  assert.equal(formatDistanceImperial(0.3048), '1 ft');
  assert.equal(formatDistanceImperial(1609), '1.0 mi');
  assert.equal(formatDistanceImperial(100_000), '62 mi');
});

test('a distance that is not a number formats as nothing', () => {
  assert.equal(formatDistance(null), '');
  assert.equal(formatDistance(-1), '');
  assert.equal(formatDistance(NaN), '');
  assert.equal(formatDistanceImperial(undefined), '');
});

test('the compass name matches the bearing', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(45), 'NE');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(180), 'S');
  assert.equal(compassPoint(270), 'W');
  assert.equal(compassPoint(359), 'N');
  /* Rounding at the boundary, since a display rounds and the name must agree. */
  assert.equal(compassPoint(22.4), 'N');
  assert.equal(compassPoint(22.6), 'NE');
  assert.equal(compassPoint(''), '');
});

/* --- the coordinate primitives still hold --------------------------------- */

test('the coordinate primitives are unchanged', () => {
  assert.equal(MAX_LATITUDE, 85.0511287798);
  assert.equal(clampLatitude(100), MAX_LATITUDE);
  assert.equal(clampLatitude('x'), 0);
  assert.equal(wrapLongitude(190), -170);
  assert.equal(wrapLongitude(-190), 170);
  assert.equal(
    normalizeLocation({ lat: 51.5073511234, lon: -0.1277584321 }).lat,
    51.507351,
  );
  assert.equal(formatCoordinates(null), 'No location');
});

/* --- locate: the three failure codes --------------------------------------- */

/*
 * A Geolocation stand-in. Every method is a stub the test drives, so the three
 * failure paths and the success path are exercised without a browser and without
 * waiting twelve seconds for any of them.
 */
function fakeGeolocation() {
  const calls = { clearWatch: 0, options: null };
  return {
    calls,
    geolocation: {
      getCurrentPosition(success, failure, options) {
        calls.options = options;
        calls.success = success;
        calls.failure = failure;
        return 7;
      },
      clearWatch() {
        calls.clearWatch += 1;
      },
    },
  };
}

/* A timer the test fires by hand, so no case waits in real time. */
function manualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimer(fn, ms) {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    clearTimer(handle) {
      scheduled[handle - 1] = null;
    },
    fire() {
      const pending = scheduled.splice(0, scheduled.length).filter(Boolean);
      for (const entry of pending) entry.fn();
    },
  };
}

test('a fix resolves with the coordinates and the reported accuracy', async () => {
  const { geolocation, calls } = fakeGeolocation();
  const timers = manualTimers();
  const pending = locateViaBrowser({
    geolocation,
    ...timers,
  });

  calls.success({
    coords: { latitude: 51.5007, longitude: -0.1246, accuracy: 1200 },
  });
  const result = await pending;

  assert.equal(result.lat, 51.5007);
  assert.equal(result.lon, -0.1246);
  assert.equal(result.error, undefined);
  /* Accuracy is passed through rather than rounded away: a desktop fix is often
     city-level, and the reader is better served by being told that. */
  assert.equal(result.accuracy, 1200);
  assert.equal(result.source, 'browser');
});

test('no location API at all is LOCATE_UNAVAILABLE', async () => {
  const result = await locateViaBrowser({ geolocation: null });
  assert.equal(result.error.code, LOCATE_UNAVAILABLE);
  /* Resolved, not rejected: a missing API is an answer, and a rejection here
     would be an unhandled rejection in the click handler. */
  assert.match(result.error.message, /does not offer/i);
});

test('a refused permission is LOCATE_DENIED, and is distinguishable', async () => {
  /*
   * Denied and unavailable are separate codes because the reader can act on one
   * and not the other: there is a permission to grant, versus no source at all.
   */
  const { geolocation, calls } = fakeGeolocation();
  const timers = manualTimers();
  const pending = locateViaBrowser({ geolocation, ...timers });

  calls.failure({ code: 1 });
  const result = await pending;

  assert.equal(result.error.code, LOCATE_DENIED);
  assert.notEqual(result.error.code, LOCATE_UNAVAILABLE);
  assert.match(result.error.message, /permission/i);
});

test('a source that cannot produce a fix is LOCATE_UNAVAILABLE', async () => {
  const { geolocation, calls } = fakeGeolocation();
  const timers = manualTimers();
  const pending = locateViaBrowser({ geolocation, ...timers });

  calls.failure({ code: 2 });
  const result = await pending;

  assert.equal(result.error.code, LOCATE_UNAVAILABLE);
});

test('a fix that arrives with nothing usable is refused, not invented', async () => {
  /*
   * The fourth case the specification does not name. Reporting 0,0 here would put
   * the reader in the Gulf of Guinea; this is why the coordinate check is not a
   * formality.
   */
  for (const coords of [
    {},
    { latitude: null, longitude: 0 },
    { latitude: 'x', longitude: 'y' },
  ]) {
    const { geolocation, calls } = fakeGeolocation();
    const timers = manualTimers();
    const pending = locateViaBrowser({ geolocation, ...timers });

    calls.success({ coords });
    const result = await pending;
    assert.equal(result.error.code, LOCATE_UNAVAILABLE, JSON.stringify(coords));
    assert.equal(result.lat, undefined, 'and no position is invented');
  }
});

test('a source that never answers is LOCATE_TIMEOUT', async () => {
  const { geolocation } = fakeGeolocation();
  const timers = manualTimers();
  const pending = locateViaBrowser({ geolocation, ...timers });

  timers.fire();
  const result = await pending;

  assert.equal(result.error.code, LOCATE_TIMEOUT);
  assert.match(result.error.message, /in time/i);
});

test('the timeout is bounded and asks for one fix, not a watch', async () => {
  /*
   * The bound is the whole reason this cannot wait forever, and
   * enableHighAccuracy: false is why it returns promptly: a desktop usually
   * cannot produce a high-accuracy fix and would otherwise hold the reader
   * through a twelve-second wait for nothing.
   */
  const { geolocation, calls } = fakeGeolocation();
  const timers = manualTimers();
  locateViaBrowser({ geolocation, ...timers });

  assert.equal(timers.scheduled.length, 1, 'a timer was armed');
  assert.equal(calls.options.enableHighAccuracy, false);
  assert.ok(calls.options.timeout > 0 && calls.options.timeout <= 12_000);
  assert.ok(calls.options.maximumAge > 0, 'a recent fix is reused');
});

test('a late callback after a timeout cannot move the map', async () => {
  /*
   * The real hazard with getCurrentPosition: some platforms call it more than
   * once, and a second callback arriving after the reader was told it failed would
   * centre the map on a position they never agreed to.
   */
  const { geolocation, calls } = fakeGeolocation();
  const timers = manualTimers();
  const pending = locateViaBrowser({ geolocation, ...timers });

  timers.fire();
  const timedOut = await pending;
  assert.equal(timedOut.error.code, LOCATE_TIMEOUT);

  calls.success({ coords: { latitude: 10, longitude: 10 } });
  const after = await pending;
  assert.deepEqual(after, timedOut, 'the same timeout answer');
  assert.equal(after.lat, undefined, 'and no late fix was accepted');
  assert.ok(calls.clearWatch > 0, 'the watch was cleared');
});

test('a real timer handle is unref-ed, so it cannot hold a process open', async () => {
  /* Same reasoning as the tile admission timer: in node a pending twelve-second
     timer is enough to keep a test run alive for twelve seconds. */
  const { geolocation, calls } = fakeGeolocation();
  const realHandles = [];
  const pending = locateViaBrowser({
    geolocation,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      realHandles.push(handle);
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle),
  });

  calls.success({ coords: { latitude: 0, longitude: 0 } });
  await pending;
  for (const handle of realHandles) {
    assert.equal(
      typeof handle.hasRef,
      'function',
      'the handle is a Timeout, so unref was available to call',
    );
  }
});

/* --- the wording ----------------------------------------------------------- */

test('a result and a failure are described differently', () => {
  const found = describeLocate({
    lat: 51.50072,
    lon: -0.12464,
    accuracy: 1200,
  });
  assert.equal(found.error, false);
  assert.match(found.message, /Showing your location/);
  assert.match(found.message, /±1200 m/, 'and the accuracy, not rounded away');

  const denied = describeLocate({
    error: { code: LOCATE_DENIED, message: 'No.' },
  });
  assert.equal(denied.error, true);
  assert.equal(denied.message, 'No.', 'the host wording is passed through');

  assert.equal(describeLocate(null).error, true);
  assert.equal(
    describeLocate({ lat: 0, lon: 0 }).message.includes('±'),
    false,
    'no accuracy, no claim',
  );
});
