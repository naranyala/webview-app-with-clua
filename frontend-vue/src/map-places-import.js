/*
 * Reading a file of places.
 *
 * Saved places could only be added one click at a time, which does not scale
 * past a handful: a survey's waypoints, a project's sites, or a route someone
 * exported from somewhere else are all files, and transcribing fifty
 * coordinates by hand is how a list ends up with thirty of them.
 *
 * Two formats, because they are the two that exist in the wild:
 *
 *   GeoJSON   a FeatureCollection of Points. Already the format the map exports
 *             and the map draws, so a round trip is a thing a reader can do.
 *   CSV       `name,lat,lon` per line. What a GPS export produces, and what
 *             someone has in a spreadsheet.
 *
 * --- What is deliberately not here -------------------------------------------
 *
 * No geocoding. A row with a name and no coordinate cannot be resolved, because
 * there is no geocoder in this app (see TODO-036) and inventing a position for a
 * place name would put a pin somewhere the file never claimed. Such a row is
 * counted and reported as skipped, which is more use to a reader than a pin in
 * the wrong place.
 *
 * The dedupe-by-coordinate and MAX_SAVED_PLACES rules are not repeated here.
 * addPlaces() routes every row through the same normalizeLocation and cap the
 * single-place path uses, so there is one set of rules rather than two that
 * agree until an edge case.
 */

import { normalizeLocation } from './geo.js';

/* How many rows to read. A cap rather than a stream: a 200-place collection
   cannot usefully hold more, and refusing a 50 MB file is kinder than reading
   it. */
export const MAX_IMPORT_ROWS = 5_000;

/*
 * Turns parsed features or CSV rows into `{ lat, lon, label }` candidates,
 * dropping anything that is not a usable point.
 *
 * Returns `{ candidates, skipped }` where `skipped` says why rows were dropped,
 * so the caller can report it rather than the reader discovering a short list
 * later and assuming the file was wrong.
 */
function collect(rows, toCandidate) {
  const candidates = [];
  let skipped = 0;
  for (const row of rows) {
    const candidate = toCandidate(row);
    if (candidate) {
      candidates.push(candidate);
    } else {
      skipped += 1;
    }
  }
  return { candidates, skipped };
}

/*
 * GeoJSON: Point features only.
 *
 * A LineString or Polygon has no single position, so taking its first vertex
 * would be a guess. Those are counted as skipped and the map still draws the
 * layer itself — importing places from a route file is not the same operation as
 * drawing the route, and conflating them would put markers in the wrong place.
 */
export function placesFromGeoJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      candidates: [],
      skipped: 1,
      error: 'That file is not valid JSON.',
    };
  }

  const features =
    data?.type === 'FeatureCollection'
      ? (data.features ?? [])
      : data?.type === 'Feature'
        ? [data]
        : null;
  if (!features) {
    return {
      candidates: [],
      skipped: 1,
      error: 'That file is not a GeoJSON FeatureCollection.',
    };
  }

  const { candidates, skipped } = collect(features, (feature) => {
    if (feature?.geometry?.type !== 'Point') return null;
    const [lon, lat] = feature.geometry.coordinates ?? [];
    const coordinates = normalizeLocation({ lat, lon });
    if (!coordinates) return null;
    /*
     * A name is not optional for a *place* — an unnamed pin is a coordinate, and
     * the collection rejects those. So a feature with no usable name is given one
     * from its coordinates rather than skipped: the reader asked for this
     * location, and a coordinate string is the label addPlace() would have made
     * up anyway.
     */
    const properties = feature.properties ?? {};
    const label =
      firstString(properties.name, properties.label, properties.title) ??
      `${coordinates.lat.toFixed(5)}, ${coordinates.lon.toFixed(5)}`;
    return { ...coordinates, label };
  });

  return { candidates, skipped };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/*
 * Splits one CSV line, honouring double quotes.
 *
 * Written out rather than pulled in because a CSV parser is the only thing this
 * app would need it for, and a hand-rolled `split(',')` is wrong the moment a
 * name contains a comma — which, for place names, it usually does.
 */
function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        /* A doubled quote inside a quoted field is one quote. */
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields;
}

/*
 * Finds the latitude and longitude columns by header name.
 *
 * Guessing by position would break on every real file: GPS exports put lon before
 * lat, spreadsheets put them wherever the author felt like it, and a swapped pair
 * puts every point in the wrong hemisphere without looking wrong.
 */
function findCoordinateColumns(header) {
  const normalized = header.map((name) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, ''),
  );
  const latitude = normalized.findIndex((name) =>
    ['lat', 'latitude'].includes(name),
  );
  const longitude = normalized.findIndex((name) =>
    ['lon', 'lng', 'long', 'longitude'].includes(name),
  );
  if (latitude === -1 || longitude === -1) return null;
  return { latitude, longitude };
}

/*
 * CSV: a header row naming the columns, then one place per line.
 *
 * A file with no header is not guessed at. `name,lat,lon` is a common shape but
 * not a safe assumption — a file of `lat,lon,name` is equally common, and reading
 * it the wrong way round produces a list of plausible places in the wrong
 * hemisphere, which is the worst kind of wrong.
 */
export function placesFromCsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { candidates: [], skipped: 0, error: 'That file is empty.' };
  }

  const header = splitCsvLine(lines[0]);
  const columns = findCoordinateColumns(header);
  if (!columns) {
    return {
      candidates: [],
      skipped: lines.length - 1,
      error:
        'The first row needs a latitude and a longitude column (lat, lon).',
    };
  }
  const nameColumn = header.findIndex((name) =>
    ['name', 'label', 'title', 'place'].includes(
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, ''),
    ),
  );

  const { candidates, skipped } = collect(
    lines.slice(1, MAX_IMPORT_ROWS + 1),
    (line) => {
      const fields = splitCsvLine(line);
      const coordinates = normalizeLocation({
        lat: fields[columns.latitude],
        lon: fields[columns.longitude],
      });
      if (!coordinates) return null;
      const label =
        firstString(nameColumn === -1 ? null : fields[nameColumn]) ??
        `${coordinates.lat.toFixed(5)}, ${coordinates.lon.toFixed(5)}`;
      return { ...coordinates, label };
    },
  );

  return { candidates, skipped };
}

/*
 * Picks the reader from the filename, defaulting to GeoJSON.
 *
 * The extension is a hint and the parse is the test: `parsePlacesFile` falls back
 * to the other reader when the first one rejects the content, so a `.csv` that
 * actually holds GeoJSON (or the reverse) still imports rather than reporting a
 * parse error the reader cannot act on.
 */
export function parsePlacesFile(name, text) {
  const looksCsv = /\.csv$/i.test(name ?? '');
  const first = looksCsv ? placesFromCsv(text) : placesFromGeoJSON(text);
  if (!first.error) return first;
  const second = looksCsv ? placesFromGeoJSON(text) : placesFromCsv(text);
  return second.error ? first : second;
}
