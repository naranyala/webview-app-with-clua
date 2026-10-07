/*
 * The README's repository map stays a map.
 *
 * I2.4 says the README, the build targets, and the source layout should agree on
 * the supported workflows, and the repository map is the part a reader consults
 * when they want to know where something lives. A map that lists only the
 * interesting files cannot answer that, and — the failure mode that actually
 * happened — a map that silently omits twenty of them looks complete while
 * omitting the whole outline-PDF and text-transfer halves of the bridge.
 *
 * So every tracked source file has to appear. Read from the filesystem rather
 * than from `git ls-files`, because the point is what is *here* now, not what is
 * committed: an uncommitted new module that the map does not mention is exactly
 * the gap worth catching.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT_URL = new URL('../../', import.meta.url);
/* fileURLToPath, not join(ROOT, ...): join() stringifies a URL into a
   `file:///...` string and then treats that as a path, which fails on every
   lookup - and fails quietly enough that the "nothing extra is listed" check
   below reported every entry as missing. */
const ROOT = fileURLToPath(ROOT_URL);
const readme = readFileSync(new URL('README.md', ROOT_URL), 'utf8');

/* The repository map block, so a mention of a path in prose elsewhere in the
   README cannot satisfy a requirement that it is in the map. */
const mapBlock = readme.slice(
  readme.indexOf('## Repository map'),
  readme.indexOf('The canonical desktop UI is'),
);

/*
 * One or more spaces before the description, not two. A long path can push its
 * description past the alignment column, and a map entry should not fail this
 * check because its name happened to be long — which is exactly what happened to
 * `tests/test_outline_roundtrip.c` the first time this ran.
 */
const listed = new Set(
  [...mapBlock.matchAll(/^([\w./-]+\.(?:c|h|lua|mjs|js|vue|awk))\s+\S/gm)].map(
    (match) => match[1],
  ),
);

function sourceFiles(directory, extensions) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, directory), {
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    if (extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(`${directory}/${entry.name}`);
    }
  }
  return found;
}

test('every native source and header file is in the repository map', () => {
  const missing = [
    ...sourceFiles('src', ['.c']),
    ...sourceFiles('include', ['.h']),
  ].filter((path) => !listed.has(path));
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

test('every Lua file is in the repository map', () => {
  const missing = [
    ...sourceFiles('lua/native', ['.lua']),
    ...sourceFiles('lua/examples', ['.lua']),
  ].filter((path) => !listed.has(path));
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

test('every C test suite is in the repository map', () => {
  const missing = sourceFiles('tests', ['.c', '.lua']).filter(
    (path) => !listed.has(path),
  );
  assert.deepEqual(missing, [], `not in the README map: ${missing.join(', ')}`);
});

test('the map lists nothing that is not there', () => {
  /*
   * The other direction. A path in the map that has been deleted or renamed is a
   * dead end for a reader, and one that reads exactly like a real entry - right
   * shape, right column alignment - so it cannot be spotted by eye.
   */
  const gone = [...listed].filter((path) => {
    /* Paths written as directory-only entries in the map are prose, not files. */
    if (!path.includes('.')) return false;
    try {
      readdirSync(join(ROOT, path));
      return false;
    } catch {
      /* Not a directory; check it as a file. */
    }
    try {
      readFileSync(join(ROOT, path));
      return false;
    } catch {
      return true;
    }
  });
  assert.deepEqual(
    gone,
    [],
    `listed in the README but missing: ${gone.join(', ')}`,
  );
});

test('the manifest and the test tree agree on the C suites', () => {
  /*
   * `tests/MANIFEST` is the single declaration point that `make`, `build.lua`, and
   * CMake all read, so a suite file that is not in it is a suite nobody runs -
   * which is worse than one that is not written. Checked here because the README
   * map and the manifest are the two lists a reader uses to decide what is
   * actually verified.
   */
  const manifest = readFileSync(new URL('tests/MANIFEST', ROOT_URL), 'utf8');
  /*
   * Manifest rows are `profile | name | sources`, and the sources are what
   * matters here. Matched by path rather than by profile name, because the
   * profiles are documented as a fixed set and a new one is a deliberate edit -
   * whereas a source file appearing on a row is the thing that has to be right.
   */
  const sources = new Set(
    [...manifest.matchAll(/^[^#|\n]+\|[^|\n]+\|[^|\n]+$/gm)].flatMap((row) =>
      [...row[0].matchAll(/tests\/(test_[\w.]+\.[ch])/g)].map(
        (match) => match[1],
      ),
    ),
  );
  assert.ok(
    sources.size >= 10,
    `only ${sources.size} suites parsed out of tests/MANIFEST; the row format must have changed`,
  );
  const onDisk = sourceFiles('tests', ['.c']);
  const unlisted = onDisk.filter(
    (path) => !sources.has(path) && !listed.has(path),
  );
  assert.deepEqual(
    unlisted,
    [],
    `in tests/ but in neither tests/MANIFEST nor the README map: ${unlisted.join(', ')}`,
  );
});
