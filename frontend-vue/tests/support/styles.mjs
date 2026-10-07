/*
 * Reads the workspace stylesheet as one text, in cascade order.
 *
 * index.css is now an ordered list of @imports rather than the rules themselves,
 * so every assertion that used to read it directly has to read the concatenation.
 * Centralised here rather than repeated per test file: the order is the whole
 * point, and a test that read the partials in directory order would be testing a
 * different stylesheet from the one that ships.
 */
import { readdirSync, readFileSync } from 'node:fs';

/*
 * Order mirrors index.css's @import list. Declared here as well as there on
 * purpose: this is the file a test failure points at, and the two drifting apart
 * would make every layout assertion below meaningless without anything failing.
 */
export const STYLE_PARTS = [
  'tokens.css',
  'shell.css',
  'toc.css',
  'pdf.css',
  'sidebars.css',
  'images.css',
  'map.css',
  'map-places.css',
  'responsive.css',
  'google-map.css',
];

const STYLES_DIR = new URL('../../src/styles/', import.meta.url);

export const styleIndex = readFileSync(
  new URL('../../src/index.css', import.meta.url),
  'utf8',
);

/* Every rule, in the order the browser will see them. */
export const styles = STYLE_PARTS.map((name) =>
  readFileSync(new URL(name, STYLES_DIR), 'utf8'),
).join('\n');

/* The @import list, as written, for checking it against STYLE_PARTS. */
export function importedStyleFiles() {
  /* Either quote style: biome normalizes CSS to double quotes, and a check that
     only matched the single quotes it was written with would fail on a formatter
     rather than on a real problem. */
  return [
    ...styleIndex.matchAll(/@import\s+["']\.\/styles\/([^"']+)["']/g),
  ].map((match) => match[1]);
}

/* Catches a file added to the directory but never imported, or vice versa. */
export function styleFilesOnDisk() {
  return readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith('.css'))
    .sort();
}
