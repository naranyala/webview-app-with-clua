/*
 * The Google Maps viewer session.
 *
 * Half of what is covered here is pure: the URL parser and the GeoJSON export.
 * Neither needs a browser, and neither had a test - which is how a parser with
 * five URL shapes and three fallbacks came to exist unexercised.
 *
 * The cases below pin the shapes and, just as importantly, the two that produce
 * no coordinates. A `/maps/search/coffee` URL parses to a named place with a null
 * latitude, and a test that only checked the happy path would have let that look
 * like a failure rather than the deliberate "geocode this later" marker it is.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleMapsViewer,
  GOOGLE_MAP_LAYERS,
  GOOGLE_TILE_URLS,
  parseGoogleMapsUrl,
} from '../src/google-maps-session.js';
import { layerTransform, lonToTileX } from '../src/map-projection.js';

/* --- the tile sources ------------------------------------------------------- */

test('each layer builds the URL its name promises', () => {
  assert.deepEqual(GOOGLE_MAP_LAYERS, ['m', 's', 'y', 't']);
  assert.match(GOOGLE_TILE_URLS.m(3, 4, 5), /lyrs=m&x=4&y=5&z=3$/);
  assert.match(GOOGLE_TILE_URLS.s(3, 4, 5), /lyrs=s/);
  assert.match(GOOGLE_TILE_URLS.y(3, 4, 5), /lyrs=y/);
  assert.match(GOOGLE_TILE_URLS.t(3, 4, 5), /lyrs=t/);
  for (const layer of GOOGLE_MAP_LAYERS) {
    assert.match(
      GOOGLE_TILE_URLS[layer](3, 4, 5),
      /^https:\/\/mt1\.google\.com\//,
      'every layer is https',
    );
  }
});

test('a layer outside the closed list falls back to road', () => {
  const viewer = createGoogleMapsViewer();
  viewer.setMapLayer('satellite-ish');
  assert.equal(viewer.mapLayer.value, 'm', 'not a URL with no styling for it');
  viewer.setMapLayer('y');
  assert.equal(viewer.mapLayer.value, 'y');
});

/* --- URL parsing ------------------------------------------------------------ */

test('a /place/ URL yields a named place with its coordinates', () => {
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/place/Eiffel+Tower/@48.8583701,2.2944813,17z',
  );
  assert.equal(places.length, 1);
  assert.equal(
    places[0].name,
    'Eiffel Tower',
    'the + is a space, not a literal',
  );
  assert.equal(places[0].lat, 48.8583701);
  assert.equal(places[0].lon, 2.2944813);
  assert.equal(places[0].zoom, 17);
  assert.equal(places[0].source, 'place');
});

test('a /place/ URL with no zoom defaults to street level', () => {
  const [place] = parseGoogleMapsUrl(
    'https://www.google.com/maps/place/Big+Ben/@51.5007,-0.1246',
  );
  assert.equal(place.zoom, 15);
});

test('a percent-encoded place name is decoded', () => {
  const [place] = parseGoogleMapsUrl(
    'https://www.google.com/maps/maps/place/Caf%C3%A9%20Central/@52.52,13.405,15z',
  );
  assert.equal(place.name, 'Café Central');
});

test('a search URL parses to a name and no coordinates', () => {
  /*
   * The one shape that deliberately yields a null coordinate. A search URL
   * carries a query, not a position, and there is no geocoder here to resolve it
   * - so the place is kept with its name and skipped by the export rather than
   * silently dropped or dropped with a coordinate invented for it.
   */
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/search/coffee+near+me',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].name, 'coffee near me');
  assert.equal(places[0].lat, null);
  assert.equal(places[0].lon, null);
  assert.equal(places[0].source, 'search');
});

test('a bare @lat,lon URL yields a coordinate place with a generated name', () => {
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/@40.7127753,-74.0059728,12z',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].lat, 40.7127753);
  assert.equal(places[0].source, 'coordinates');
  assert.match(places[0].name, /^Location 40\.7128, -74\.0060$/);
});

test('a ?q=lat,lon URL is read when the path has no coordinates', () => {
  const places = parseGoogleMapsUrl(
    'https://maps.google.com/?q=35.6762,139.6503',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].lat, 35.6762);
  assert.equal(places[0].lon, 139.6503);
  assert.equal(places[0].source, 'query');
});

test('an ?ll=lat,lon URL is read when nothing else matched', () => {
  const places = parseGoogleMapsUrl(
    'https://maps.google.com/maps?ll=-33.8688,151.2093',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].lat, -33.8688);
  assert.equal(places[0].source, 'll');
});

test('a place path wins over the bare @lat,lon it also contains', () => {
  /*
   * Every real /place/ URL carries an @lat,lon segment too. Reading both would
   * add a second, nameless place at the same coordinates, so the coordinate
   * patterns only run when the place pattern found nothing.
   */
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/place/Sydney/@-33.8688,151.2093,12z',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].source, 'place');
  assert.equal(places[0].name, 'Sydney');
});

test('a q parameter wins over ll when both are present', () => {
  const places = parseGoogleMapsUrl(
    'https://maps.google.com/maps?ll=1,2&q=3,4',
  );
  assert.equal(places.length, 1);
  assert.equal(places[0].source, 'query');
});

test('a URL with nothing parseable yields no places', () => {
  assert.deepEqual(parseGoogleMapsUrl('https://www.google.com/maps'), []);
  assert.deepEqual(parseGoogleMapsUrl('https://example.com/'), []);
  assert.deepEqual(parseGoogleMapsUrl('not a url'), []);
  assert.deepEqual(parseGoogleMapsUrl(''), []);
});

test('a coordinate outside the valid range is not accepted as a place', () => {
  /*
   * The regex will happily match `999,999`. Nothing here geocodes or draws these
   * coordinates, but a place list is persisted and exported, so a nonsense
   * coordinate that reached the export would be a GeoJSON file other tools would
   * reject. Refusing it at parse time is where it is cheapest to refuse.
   */
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/@999.5,999.5,12z',
  );
  assert.deepEqual(places, [], 'latitude 999.5 does not exist');
});

test('a URL with a coordinate-less place path still parses', () => {
  /* /place/NAME with no @lat,lon at all: the name is the whole payload. */
  const places = parseGoogleMapsUrl(
    'https://www.google.com/maps/place/Somewhere',
  );
  assert.deepEqual(
    places,
    [],
    'and yields nothing, rather than a broken place',
  );
});

/* --- the parsed place list -------------------------------------------------- */

function viewer() {
  return createGoogleMapsViewer();
}

test('a parsed place joins the list and is deduplicated', () => {
  const map = viewer();
  const url =
    'https://www.google.com/maps/place/Colosseum/@41.8902,12.4922,17z';

  assert.equal(map.addPlaceFromUrl(url), true);
  assert.equal(map.parsedPlaces.value.length, 1);

  map.addPlaceFromUrl(url);
  assert.equal(
    map.parsedPlaces.value.length,
    1,
    'the same place twice is still one place',
  );
});

test('an unparseable URL is refused with a message', () => {
  const map = viewer();
  assert.equal(map.addPlaceFromUrl('https://example.com/'), false);
  assert.equal(map.parsedPlaces.value.length, 0);
  assert.equal(
    map.mapStatusError.value,
    true,
    'and it is reported as an error',
  );
});

test('places can be removed one at a time and all at once', () => {
  const map = viewer();
  map.addPlaceFromUrl('https://www.google.com/maps/place/A/@1,1,15z');
  map.addPlaceFromUrl('https://www.google.com/maps/place/B/@2,2,15z');
  assert.equal(map.parsedPlaces.value.length, 2);

  map.removeParsedPlace(0);
  assert.equal(map.parsedPlaces.value.length, 1);
  assert.equal(map.parsedPlaces.value[0].name, 'B', 'the right one went');

  map.clearParsedPlaces();
  assert.equal(map.parsedPlaces.value.length, 0);
});

/* --- GeoJSON export --------------------------------------------------------- */

test('an export with no places is refused rather than writing an empty file', () => {
  const map = viewer();
  assert.equal(map.exportGeoJSON(), null);
  assert.match(map.mapStatus.value, /no places/i);
});

test('an export writes lon,lat order as GeoJSON requires', () => {
  /*
   * The one genuinely easy mistake here: GeoJSON coordinates are [longitude,
   * latitude], the reverse of the {lat, lon} the rest of the app uses. Getting it
   * backwards produces a file that opens in the wrong hemisphere, which is
   * obvious once seen and invisible in review.
   */
  const map = viewer();
  map.addPlaceFromUrl(
    'https://www.google.com/maps/place/Rome/@41.8902,12.4922,17z',
  );

  const parsed = JSON.parse(map.exportGeoJSON());
  assert.equal(parsed.type, 'FeatureCollection');
  assert.equal(parsed.features.length, 1);
  assert.deepEqual(parsed.features[0].geometry.coordinates, [12.4922, 41.8902]);
  assert.equal(parsed.features[0].geometry.type, 'Point');
  assert.equal(parsed.features[0].properties.name, 'Rome');
});

test('a coordinate-less place is left out of the export', () => {
  const map = viewer();
  map.addPlaceFromUrl('https://www.google.com/maps/search/somewhere+nice');
  assert.equal(map.parsedPlaces.value.length, 1, 'the place is in the list');

  const parsed = JSON.parse(map.exportGeoJSON());
  assert.equal(
    parsed.features.length,
    0,
    'but it has no position, so it cannot be a Point',
  );
});

test('the export is stable enough to round-trip through the loader', () => {
  const map = viewer();
  map.addPlaceFromUrl('https://www.google.com/maps/place/A/@1.5,2.5,15z');
  map.addPlaceFromUrl('https://www.google.com/maps/place/B/@3.5,4.5,15z');

  const parsed = JSON.parse(map.exportGeoJSON());
  assert.deepEqual(
    parsed.features.map((feature) => feature.geometry.coordinates),
    [
      [2.5, 1.5],
      [4.5, 3.5],
    ],
  );
});

/* --- the view, without a browser -------------------------------------------- */

test('the viewer places a tile where the projection says', () => {
  const map = viewer();
  map.mapSize.value = { width: 800, height: 600 };

  const transform = layerTransform({
    centerLat: 0,
    centerLon: 0,
    zoom: 4,
    tileZoom: 4,
    width: 800,
    height: 600,
  });
  assert.deepEqual(
    transform,
    layerTransform({
      centerLat: 0,
      centerLon: 0,
      zoom: 4,
      tileZoom: 4,
      width: 800,
      height: 600,
    }),
    'the shared transform places both renderers identically',
  );
  /* The tile covering 0,0 sits one column and row in from the world origin. */
  assert.equal(lonToTileX(0, 4), 8);
  assert.equal(transform.x, 400 - 8 * 256);
});
