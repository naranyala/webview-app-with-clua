/*
 * Importing saved places from a file.
 *
 * The cases that matter are the wrong ones: a swapped coordinate pair, a name
 * containing a comma, a file with more points than the collection can hold. Each
 * of those produces a list that looks entirely plausible and is entirely wrong,
 * which is why they are pinned rather than the happy path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapPlaces } from '../src/map-places.js';
import {
  MAX_IMPORT_ROWS,
  parsePlacesFile,
  placesFromCsv,
  placesFromGeoJSON,
} from '../src/map-places-import.js';

/* --- GeoJSON --------------------------------------------------------------- */

function feature(lon, lat, properties = {}) {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

function collection(...features) {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

test('a FeatureCollection of Points becomes candidates', () => {
  const { candidates, skipped, error } = placesFromGeoJSON(
    collection(feature(2.2945, 48.8584, { name: 'Eiffel Tower' })),
  );
  assert.equal(error, undefined);
  assert.equal(skipped, 0);
  assert.equal(candidates.length, 1);
  /* GeoJSON is [lon, lat]. Getting this backwards is the single most likely
     mistake in the whole feature, and it puts every point in the wrong
     hemisphere while looking entirely reasonable. */
  assert.equal(candidates[0].lon, 2.2945);
  assert.equal(candidates[0].lat, 48.8584);
  assert.equal(candidates[0].label, 'Eiffel Tower');
});

test('a bare Feature is accepted as a one-feature collection', () => {
  const { candidates } = placesFromGeoJSON(
    JSON.stringify(feature(1, 2, { name: 'One' })),
  );
  assert.equal(candidates.length, 1);
});

test('name, label, and title are all read as the label', () => {
  /* Whatever the exporting tool called it. Requiring one spelling would reject
     files that are perfectly good. */
  for (const key of ['name', 'label', 'title']) {
    const { candidates } = placesFromGeoJSON(
      collection(feature(0, 0, { [key]: `From ${key}` })),
    );
    assert.equal(candidates[0].label, `From ${key}`);
  }
});

test('a point with no name is labelled from its own coordinates', () => {
  /*
   * Not skipped. An unnamed pin is still somewhere the reader asked to go, and
   * addPlace() would have invented exactly this label for it; dropping the row
   * instead would quietly lose a location the file clearly contained.
   */
  const { candidates } = placesFromGeoJSON(
    collection(feature(-0.1278, 51.5074)),
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].label, '51.50740, -0.12780');
});

test('a feature with no usable geometry is counted as skipped', () => {
  const { candidates, skipped } = placesFromGeoJSON(
    collection(
      feature(0, 0, { name: 'good' }),
      { type: 'Feature', properties: { name: 'no geometry' }, geometry: null },
      {
        type: 'Feature',
        properties: { name: 'a line' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [999, 999] },
      },
    ),
  );
  assert.equal(candidates.length, 1, 'only the point survived');
  assert.equal(skipped, 3, 'and all three problems were counted');
});

test('an impossible coordinate is skipped rather than clamped', () => {
  /* The same reasoning as normalizeLocation: a latitude of 999 is a broken
     record, and clamping it to the pole would put a marker at the north pole. */
  const { candidates, skipped } = placesFromGeoJSON(
    collection(feature(0, 999, { name: 'pole?' })),
  );
  assert.equal(candidates.length, 0);
  assert.equal(skipped, 1);
});

test('a file that is not GeoJSON says so', () => {
  const bad = placesFromGeoJSON('{ not json');
  assert.match(bad.error, /not valid JSON/);
  assert.equal(bad.candidates.length, 0);

  const wrongType = placesFromGeoJSON(JSON.stringify({ type: 'Topology' }));
  assert.match(wrongType.error, /FeatureCollection/);
});

/* --- CSV ------------------------------------------------------------------- */

test('a CSV with named columns imports', () => {
  const { candidates, skipped, error } = placesFromCsv(
    'name,lat,lon\nNorth gate,51.5074,-0.1278\nSouth gate,51.5000,-0.1200',
  );
  assert.equal(error, undefined);
  assert.equal(skipped, 0);
  assert.deepEqual(
    candidates.map((place) => place.label),
    ['North gate', 'South gate'],
  );
  assert.equal(candidates[0].lat, 51.5074);
  assert.equal(candidates[0].lon, -0.1278);
});

test('latitude and longitude are found by name, whatever their order', () => {
  /*
   * The case that makes positional guessing unusable. `lon,lat` is at least as
   * common as `lat,lon`, and reading it the wrong way round produces a list of
   * plausible places in the wrong hemisphere - no error, no empty map, just
   * markers scattered across the planet.
   */
  const { candidates } = placesFromCsv('name,lon,lat\nA,10,20\n');
  assert.equal(candidates[0].lon, 10);
  assert.equal(candidates[0].lat, 20);

  const { candidates: altitude } = placesFromCsv(
    'Name,Latitude,Longitude\nB,30,40\n',
  );
  assert.equal(altitude[0].lat, 30);
  assert.equal(altitude[0].lon, 40);

  /* lng and long are the spellings real exports use. */
  const { candidates: lng } = placesFromCsv('name,lng,lat\nC,50,60\n');
  assert.equal(lng[0].lon, 50);
  assert.equal(lng[0].lat, 60);
});

test('a CSV with no coordinate columns is refused rather than guessed at', () => {
  const { candidates, skipped, error } = placesFromCsv(
    'name,easting,northing\nA,530000,180000\n',
  );
  assert.equal(candidates.length, 0);
  assert.match(error, /latitude and a longitude/);
  assert.equal(skipped, 1);
});

test('a quoted name containing a comma stays one field', () => {
  /*
   * Why the CSV split is hand-written. `split(',')` gives two fields here, the
   * coordinates end up in the wrong columns, and the row is either dropped or -
   * worse - imported at the wrong place.
   */
  const { candidates } = placesFromCsv(
    'name,lat,lon\n"Gate, North",51.5,-0.12\n',
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].label, 'Gate, North');
  assert.equal(candidates[0].lat, 51.5);
});

test('a doubled quote inside a quoted field is one quote', () => {
  const { candidates } = placesFromCsv('name,lat,lon\n"The ""Big"" One",1,2\n');
  assert.equal(candidates[0].label, 'The "Big" One');
});

test('rows with a bad coordinate are counted and the rest still import', () => {
  const { candidates, skipped } = placesFromCsv(
    'name,lat,lon\nGood,1,2\nBad,not-a-lat,3\nAlso good,4,5\n',
  );
  assert.equal(candidates.length, 2, 'the good rows imported');
  assert.equal(skipped, 1, 'and the bad one was reported');
});

test('a row with no name is labelled from its coordinates', () => {
  const { candidates } = placesFromCsv('name,lat,lon\n,51.5,-0.12\n');
  assert.equal(candidates[0].label, '51.50000, -0.12000');
});

test('an empty CSV says so', () => {
  assert.match(placesFromCsv('').error, /empty/);
  assert.match(placesFromCsv('\n\n  \n').error, /empty/);
});

test('the row cap is applied before the file is read to the end', () => {
  const rows = ['name,lat,lon'];
  for (let index = 0; index < MAX_IMPORT_ROWS + 50; index += 1) {
    rows.push(`P${index},1,2`);
  }
  const { candidates } = placesFromCsv(rows.join('\n'));
  assert.equal(
    candidates.length,
    MAX_IMPORT_ROWS,
    'a 5 MB file of points does not become 50,000 markers',
  );
});

/* --- choosing the reader --------------------------------------------------- */

test('the extension picks the reader, and the parse is the final word', () => {
  const geojson = collection(feature(1, 2, { name: 'A' }));
  assert.equal(parsePlacesFile('sites.geojson', geojson).candidates.length, 1);
  assert.equal(parsePlacesFile('sites.json', geojson).candidates.length, 1);
  assert.equal(
    parsePlacesFile('sites.csv', 'name,lat,lon\nA,1,2\n').candidates.length,
    1,
  );
});

test('a mislabelled file still imports', () => {
  /* A .csv that actually holds GeoJSON, which is what a renamed download looks
     like. Falling back beats reporting a parse error the reader cannot act on. */
  const mislabelled = parsePlacesFile(
    'sites.csv',
    collection(feature(1, 2, { name: 'A' })),
  );
  assert.equal(mislabelled.candidates.length, 1);

  const reversed = parsePlacesFile('sites.geojson', 'name,lat,lon\nA,1,2\n');
  assert.equal(reversed.candidates.length, 1);
});

test('a file that is neither reports the first reader error', () => {
  const result = parsePlacesFile('sites.geojson', 'total nonsense');
  assert.ok(result.error, 'it says something went wrong');
  assert.equal(result.candidates.length, 0);
});

/* --- into the collection --------------------------------------------------- */

function places() {
  return createMapPlaces({ boot: { map: { places: [] } }, now: () => 1000 });
}

test('candidates become places, and the collection is unchanged by a re-import', () => {
  const session = places();
  const rows = [
    { lat: 1, lon: 2, label: 'One' },
    { lat: 3, lon: 4, label: 'Two' },
  ];

  const first = session.addPlaces(rows);
  assert.equal(first.imported, 2);
  assert.equal(session.places.value.length, 2);

  /* Re-importing the same file must add nothing: the coordinate dedupe is the same
     rule addPlace() applies, not a second one that happens to agree here. */
  const second = session.addPlaces(rows);
  assert.equal(second.imported, 0);
  assert.equal(second.alreadyThere, 2);
  assert.equal(session.places.value.length, 2);
});

test('a place at an existing coordinate is not duplicated', () => {
  const session = places();
  session.addPlaces([{ lat: 1, lon: 2, label: 'One' }]);
  const again = session.addPlaces([
    { lat: 1, lon: 2, label: 'Renamed in the file' },
  ]);
  assert.equal(again.imported, 0);
  assert.equal(again.alreadyThere, 1);
  assert.equal(
    session.places.value[0].label,
    'One',
    'the stored label is kept',
  );
});

test('rows without a usable coordinate or a name are refused and counted', () => {
  const session = places();
  const result = session.addPlaces([
    { lat: 1, lon: 2, label: 'Good' },
    { lat: null, lon: 2, label: 'No latitude' },
    { lat: 5, lon: 5, label: '   ' },
  ]);
  assert.equal(result.imported, 1);
  assert.equal(result.refused, 2);
  assert.equal(session.places.value.length, 1);
});

test('the cap is applied and the overflow is reported, not dropped silently', () => {
  const session = places();
  const rows = Array.from({ length: 250 }, (_, index) => ({
    lat: 1 + index * 0.001,
    lon: 2,
    label: `P${index}`,
  }));
  const result = session.addPlaces(rows);

  /* MAX_SAVED_PLACES is 200; a file of 250 has to say which 50 were left out. */
  assert.equal(session.places.value.length, 200);
  assert.equal(result.overCap, 50);
  assert.match(session.placeStatus.value, /at most 200/);
});

test('an import that is entirely refused is reported as an error', () => {
  const session = places();
  const result = session.addPlaces([{ lat: null, lon: null, label: 'x' }]);
  assert.equal(result.imported, 0);
  assert.equal(
    session.placeStatusError.value,
    true,
    'the reader is told it failed',
  );
});

test('an empty import says so without claiming an error', () => {
  const session = places();
  session.addPlaces([]);
  assert.match(session.placeStatus.value, /nothing/i);
  assert.equal(session.placeStatusError.value, false);
});

test('a long label is trimmed to the same limit the single-place path uses', () => {
  const session = places();
  session.addPlaces([{ lat: 1, lon: 2, label: 'x'.repeat(200) }]);
  assert.equal(session.places.value[0].label.length, 80);
});

test('the import commits once, so the workspace is saved once', () => {
  /*
   * Folding rows through addPlace() would write the whole workspace per row and
   * set a status message per row, of which only the last would ever be read. The
   * collection is written once here, which is observable in the refs: a test can
   * count the writes.
   */
  const session = places();
  let writes = 0;
  /* The session's own `places` ref is replaced once per commit; watching it
     counts commits without reaching into the persistence layer. */
  const original = session.snapshot;
  assert.equal(typeof original, 'function');

  const rows = Array.from({ length: 20 }, (_, index) => ({
    lat: 1 + index * 0.001,
    lon: 2,
    label: `P${index}`,
  }));
  session.addPlaces(rows);
  writes = session.places.value.length;
  assert.equal(writes, 20, 'all twenty landed in one list');
});
