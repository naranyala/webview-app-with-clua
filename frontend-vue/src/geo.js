/*
 * Coordinate primitives shared by the map, the workspace schema, and the UI.
 *
 * These live apart from map-explorer.js on purpose. The schema needs to validate
 * a stored coordinate, and the map needs to validate a clicked one; if the
 * schema imported the map module it would close a cycle
 * (map -> boot-state -> workspace -> map) that left the map's default arguments
 * reading an uninitialised import. A small leaf module both can depend on ends
 * the cycle without duplicating the rules.
 */

/*
 * Mercator diverges at the poles, so the usable latitude range is bounded. This
 * is the standard cut-off (~85.0511 degrees), beyond which the projection would
 * produce an infinite y and an unusable tile index.
 */
export const MAX_LATITUDE = 85.0511287798;

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

/*
 * A stored coordinate may arrive as a number or as a numeric string - a CSV cell,
 * or a hand-edited workspace - and both are accepted.
 *
 * Nothing else is. `Number()` is not used because its coercions are all silent and
 * all produce plausible coordinates from nothing: Number(null), Number(''), and
 * Number([]) are 0, so a record whose latitude was cleared rather than deleted
 * becomes a point on the equator off the coast of Ghana, and Number(true) is 1.
 * Every such record reads as somewhere real, which is the worst way for corrupt
 * input to fail - it cannot be spotted by looking at the map.
 */
function toCoordinateNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/*
 * A coordinate pair, or null when the value is not a usable one.
 *
 * Every stored place and every stored link goes through this, so a corrupt or
 * hand-edited record reads as "nothing here" instead of putting NaN on the map.
 * Out-of-range values are rejected rather than clamped, because a latitude of 400
 * is a broken record and silently turning it into the north pole would hide the
 * corruption.
 */
export function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = toCoordinateNumber(value.lat);
  const lon = toCoordinateNumber(value.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lon < -180 || lon > 180) return null;
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  return {
    /* Six decimals is ~11 cm, well past GPS accuracy, and keeps the persisted
       record short. */
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

/* --- measuring between two points ------------------------------------------ */

/*
 * The mean Earth radius, in metres (IUGG). The sphere is wrong by up to ~0.5%
 * against the WGS-84 ellipsoid, which is why this is never used for anything a
 * surveyor would check - but it is the right model for "how far apart are these
 * two pins on my screen", and picking a radius constant is not where accuracy
 * beyond that is won.
 */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

/*
 * Great-circle distance in metres, by the haversine form.
 *
 * Haversine rather than the spherical law of cosines because the latter loses
 * precision for two nearby points - the case that matters most here, since the
 * distances on screen are usually between pins a few streets apart, and `acos` of
 * a number very close to 1 is where it falls apart.
 */
export function distanceMeters(from, to) {
  const a = normalizeLocation(from);
  const b = normalizeLocation(to);
  if (!a || !b) return null;

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLon = toRadians(b.lon - a.lon);

  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  /* Clamped because sin^2 can come back as 1.0000000000000002 on the last bit of
     a very long path, and asin(1.0000000000000002) is NaN. */
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/*
 * Initial bearing from one point to another, in degrees clockwise from true
 * north, so 0 is north and 90 is east.
 *
 * "Initial" because that is the only kind this can be: the bearing changes along
 * the path. Two points on opposite sides of the antimeridian are the case worth
 * checking - atan2 of a naive longitude difference would send the reader west
 * when the short way is east.
 */
export function bearingDegrees(from, to) {
  const a = normalizeLocation(from);
  const b = normalizeLocation(to);
  if (!a || !b) return null;

  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLon = toRadians(b.lon - a.lon);

  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/* One decimal below 10 km, none above. "1.2 km" is more use than "1.24 km". */
export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 1) return `${Math.round(meters * 100)} cm`;
  if (meters < 1000) return `${Math.round(meters)} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/* The same distance in miles and feet, to sit beside the metric one. */
export function formatDistanceImperial(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '';
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

/*
 * The eight-point compass name for a bearing, which is what a reader can act on.
 * "043°" is precise and unreadable; "NE" is the other way round. Both are shown,
 * because this is a status line and one of them is the answer.
 */
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compassPoint(degrees) {
  if (!Number.isFinite(degrees)) return '';
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[index];
}
