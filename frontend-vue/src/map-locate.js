/*
 * Where the reader is.
 *
 * TODO-039's locate half is blocked on libcurl and GeoClue2 in the C host, and
 * until that ships there is no locate at all. That is a long wait for a feature
 * the browser can already do, so this uses `navigator.geolocation` now and is
 * written to be replaced rather than rewritten.
 *
 * --- The contract that makes replacement cheap ------------------------------
 *
 * TODO-039 specifies `locateMapPlace` with exactly three failure codes. This
 * module returns those same three, with the same meanings, so swapping the
 * transport is a change to one function (`locateViaBrowser`) and nothing else -
 * not a rewrite of the status line, the tests, or the button. The three:
 *
 *   LOCATE_UNAVAILABLE  no position source here at all (no API, no daemon)
 *   LOCATE_DENIED       permission refused, or the user dismissed the prompt
 *   LOCATE_TIMEOUT      the source did not answer inside the bound
 *
 * A fourth case exists that the specification does not name: a fix that arrives
 * but carries no usable coordinate. It is reported as LOCATE_UNAVAILABLE rather
 * than invented into a position, for the same reason normalizeLocation rejects
 * an out-of-range coordinate instead of clamping it.
 *
 * --- Why the browser API is not the same guarantee ---------------------------
 *
 * It is a weaker promise and the status line says so where it matters. In a
 * browser this resolves against the OS's location service, which on a desktop is
 * often city-level or absent. The native GeoClue2 path is a system bus read with
 * a real provider behind it. Same interface, different quality — which is why
 * this does not close TODO-039, and why the accuracy the browser reports is
 * passed through to the reader instead of being rounded away.
 */

/* The three codes, exported so tests and callers share one spelling. */
export const LOCATE_UNAVAILABLE = 'LOCATE_UNAVAILABLE';
export const LOCATE_DENIED = 'LOCATE_DENIED';
export const LOCATE_TIMEOUT = 'LOCATE_TIMEOUT';

/*
 * How long to wait. Long enough for a cold fix from a GPS receiver, short enough
 * that a reader who has denied it is not left watching a spinner: the permission
 * prompt alone can take as long as the reader wants.
 */
export const LOCATE_TIMEOUT_MS = 12_000;

/* An error shaped like the host's, so every existing status path handles it. */
function failure(code, message) {
  return { error: { code, message } };
}

/*
 * The browser's GeolocationPositionError codes, mapped. 1 and 2 both mean "no":
 * PERMISSION_DENIED covers a refusal, POSITION_UNAVAILABLE covers a source that
 * cannot produce a fix. They are reported differently because the reader can act
 * on one and not the other.
 */
function fromPositionError(error) {
  if (error?.code === 1) {
    return failure(
      LOCATE_DENIED,
      'Location permission was refused, so the map cannot centre on you.',
    );
  }
  return failure(
    LOCATE_UNAVAILABLE,
    'This device has no location source the browser can use.',
  );
}

/*
 * Resolves a position through `navigator.geolocation`.
 *
 * Every dependency is injected — the geolocation object, the timer functions, the
 * timeout — so the three failure paths are exercised in node without a browser
 * and without waiting twelve seconds for any of them.
 */
export function locateViaBrowser({
  geolocation = globalThis.navigator?.geolocation,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (handle) => globalThis.clearTimeout(handle),
  timeoutMs = LOCATE_TIMEOUT_MS,
} = {}) {
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    return Promise.resolve(
      failure(
        LOCATE_UNAVAILABLE,
        'This device does not offer a location the map can use.',
      ),
    );
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      /*
       * clearWatch, not nothing: getCurrentPosition can fire more than once on
       * some platforms, and a late second callback after we have timed out would
       * move the map under a reader who was already told it failed.
       */
      geolocation.clearWatch?.(watchId);
      resolve(result);
    };

    const timer = setTimer(() => {
      finish(
        failure(
          LOCATE_TIMEOUT,
          'No location arrived in time. Check that location services are on.',
        ),
      );
    }, timeoutMs);
    /* Unref'd for the same reason the tile admission timer is: in node a pending
       twelve-second timer is enough to hold a test run open. A no-op in a
       browser, where the handle is a number. */
    timer?.unref?.();

    let watchId = null;
    watchId = geolocation.getCurrentPosition(
      (position) => {
        const coords = position?.coords;
        /*
         * Coerced by hand rather than through Number(), because Number(null) and
         * Number('') are both 0: a provider that reports a null latitude would put
         * the reader at 0,0 in the Gulf of Guinea with no error anywhere. Only a
         * value that is genuinely a number is accepted.
         */
        const lat =
          typeof coords?.latitude === 'number' ? coords.latitude : NaN;
        const lon =
          typeof coords?.longitude === 'number' ? coords.longitude : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          /* A fix arrived with nothing usable in it. Reported as unavailable
             rather than dropped silently or turned into 0,0. */
          finish(
            failure(
              LOCATE_UNAVAILABLE,
              'The location that arrived had no usable coordinates.',
            ),
          );
          return;
        }
        finish({
          lat,
          lon,
          /*
           * Passed through rather than rounded: a desktop fix is often accurate
           * to a city, and the reader is better served by being told that than by
           * being shown six decimal places of confidence the device does not
           * have.
           */
          accuracy: Number.isFinite(Number(coords?.accuracy))
            ? Number(coords.accuracy)
            : null,
          source: 'browser',
        });
      },
      (error) => finish(fromPositionError(error)),
      {
        /*
         * One fix, not a watch: the map needs to know where the reader is now,
         * not to track them. enableHighAccuracy would also mean waiting far longer
         * for a fix that a desktop usually cannot provide.
         */
        enableHighAccuracy: false,
        timeout: timeoutMs,
        maximumAge: 60_000,
      },
    );
  });
}

/*
 * The same sentence the status line will show, for a result from either
 * transport. Keeping the wording here rather than at each call site is what stops
 * the native path and this one from describing the same outcome differently.
 */
export function describeLocate(result) {
  if (!result) {
    return {
      message: 'The location could not be read.',
      error: true,
    };
  }
  if (result.error) {
    return { message: result.error.message, error: true };
  }
  const where = `${result.lat.toFixed(5)}, ${result.lon.toFixed(5)}`;
  const accuracy =
    result.accuracy === null || result.accuracy === undefined
      ? ''
      : ` (±${Math.round(result.accuracy)} m)`;
  return {
    message: `Showing your location: ${where}${accuracy}.`,
    error: false,
  };
}
