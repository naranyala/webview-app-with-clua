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
  const lat = Number(value.lat);
  const lon = Number(value.lon);
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
