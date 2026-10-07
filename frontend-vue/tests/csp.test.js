/*
 * The Content-Security-Policy.
 *
 * The policy matters for one thing above all: it is the only enforcement of the
 * tile-host allowlist that docs/map-sources.md describes. Until it shipped, that
 * document was the whole of the policy.
 *
 * Two failure modes are pinned here, because either one produces an app that
 * looks broken rather than an app that is protected. A policy with script-src
 * 'self' and nothing else blocks the inlined production bundle outright - the app
 * never starts. A policy missing from the built artifact blocks nothing at all
 * while reading as if it does. Both are silent, so both are asserted.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildCsp,
  CSP_DIRECTIVES,
  cspMetaTag,
  TILE_HOSTS,
  withInlineHashes,
} from '../src/csp.js';

const BUILT = new URL('../dist/index.html', import.meta.url);
const built = existsSync(BUILT) ? readFileSync(BUILT, 'utf8') : null;

/* --- the policy itself ------------------------------------------------------ */

test('the tile hosts in the policy are the ones the map fetches', () => {
  /*
   * The whole point of generating the policy from a constant rather than typing
   * it into the HTML: these two lists cannot drift. If a session adds a tile
   * source, this fails until TILE_HOSTS names it - which is the moment to
   * decide whether it should be reachable, rather than after it has been.
   */
  assert.deepEqual(TILE_HOSTS, ['tile.openstreetmap.org', 'mt1.google.com']);
  for (const host of TILE_HOSTS) {
    assert.match(
      buildCsp(),
      new RegExp(`\\b${host.replaceAll('.', '\\.')}\\b`),
    );
  }
});

test('the tile hosts are in img-src and not in connect-src', () => {
  /*
   * Tiles are fetched by <img src>, so img-src is the directive that governs
   * them. Putting a third-party host in connect-src as well would be the shape
   * that lets a fetch() reach it - the crossing I1.2 exists to keep page-side.
   */
  const policy = buildCsp();
  const imgSrc = policy.split('; ').find((part) => part.startsWith('img-src'));
  const connectSrc = policy
    .split('; ')
    .find((part) => part.startsWith('connect-src'));
  for (const host of TILE_HOSTS) {
    assert.match(imgSrc, new RegExp(host.replaceAll('.', '\\.')));
    assert.doesNotMatch(connectSrc, new RegExp(host.replaceAll('.', '\\.')));
  }
  assert.equal(connectSrc, "connect-src 'self'");
});

test('no directive is left open to everything', () => {
  const policy = buildCsp();
  assert.doesNotMatch(policy, /default-src[^;]*\*/, 'no wildcard source');
  /*
   * 'wasm-unsafe-eval' contains the substring "unsafe-eval", so a plain word
   * boundary would flag the narrow grant this policy deliberately uses. The
   * lookbehind requires that what precedes is not part of a longer keyword.
   */
  assert.doesNotMatch(
    policy,
    /(?<![\w-])unsafe-eval/,
    'the broad eval grant is not present',
  );
  assert.match(policy, /script-src[^;]*'wasm-unsafe-eval'/);
});

test('frame, object, and base are closed off', () => {
  /* The app has no frames, no plugins, and no <base>. Saying so costs nothing
     and removes three ways in. */
  const policy = buildCsp();
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
});

test('the meta tag carries the policy and quotes it correctly', () => {
  const tag = cspMetaTag();
  assert.match(tag, /^<meta http-equiv="Content-Security-Policy" content="/);
  assert.match(tag, /"\s*\/>$/);
  /* Single quotes inside a double-quoted attribute: the common way this breaks
     is an unescaped quote in the content, which would end the attribute early
     and truncate the policy without any error. */
  assert.equal(tag.match(/"/g).length, 4);
});

test('a hash list is appended to script-src and nowhere else', () => {
  const directives = withInlineHashes({ script: ["'sha256-abc'"] });
  const scriptSrc = directives.find(([name]) => name === 'script-src')[1];
  assert.ok(scriptSrc.includes("'sha256-abc'"));
  assert.ok(scriptSrc.includes("'self'"), 'and keeps same-origin scripts');
  const imgSrc = directives.find(([name]) => name === 'img-src')[1];
  assert.ok(!imgSrc.includes('sha256'), 'a script hash is not an image source');
});

test('the policy has no directive left undefined', () => {
  for (const [name, sources] of CSP_DIRECTIVES) {
    assert.ok(sources.length > 0, `${name} has at least one source`);
    for (const source of sources) {
      assert.equal(typeof source, 'string', `${name} source is a string`);
      assert.ok(source.length > 0, `${name} source is not empty`);
    }
  }
});

/* --- the built artifact ----------------------------------------------------- */

/*
 * These read dist/index.html rather than the plugin's output directly, because the
 * claim being made is about the file the desktop host loads. A policy that is
 * correct in a function and missing from the artifact protects nothing, and the
 * only way to tell the difference is to look at the artifact.
 *
 * Skipped rather than failed when there is no build: `npm test` runs in places
 * the bundle has not been produced, and a test that fails for want of a build
 * teaches people to ignore it.
 */
const describeBuilt = built ? test : test.skip;

describeBuilt('the built page carries the policy', () => {
  test('the meta tag is in the document', () => {
    assert.match(
      built,
      /<meta http-equiv="Content-Security-Policy" content="[^"]+"\s*\/>/,
      'dist/index.html has no Content-Security-Policy',
    );
  });

  test('the policy in the artifact names the tile hosts', () => {
    const policy = built.match(
      /http-equiv="Content-Security-Policy" content="([^"]+)"/,
    )[1];
    for (const host of TILE_HOSTS) {
      assert.match(policy, new RegExp(host.replaceAll('.', '\\.')));
    }
  });

  test('the policy is in the head, before anything it governs', () => {
    const headEnd = built.indexOf('</head>');
    assert.ok(headEnd > 0, 'the document has a head');
    assert.ok(
      built.indexOf('Content-Security-Policy') < headEnd,
      'a policy after </head> does not govern the stylesheet',
    );
  });

  test('the inline script has a hash that matches its bytes', () => {
    /*
     * The failure this prevents is an app that does not start: the build inlines
     * the bundle into one <script>, so script-src without a matching hash blocks
     * the only script there is. Recomputing the hash here means a change to the
     * plugin's hashing - whitespace, encoding, which script is picked - fails
     * here rather than in the desktop host.
     */
    const policy = built.match(
      /http-equiv="Content-Security-Policy" content="([^"]+)"/,
    )[1];
    const hashes = [...policy.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map(
      (match) => match[0],
    );
    assert.ok(
      hashes.length > 0,
      'script-src has no hash, so the bundle is blocked',
    );

    const inlineScripts = [
      ...built.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
    ].map((match) => match[1]);
    assert.ok(inlineScripts.length > 0, 'no inline script to hash');

    for (const body of inlineScripts) {
      const digest = createHash('sha256').update(body, 'utf8').digest('base64');
      assert.ok(
        hashes.includes(`'sha256-${digest}'`),
        'an inline script in the artifact has no matching hash in the policy',
      );
    }
  });

  test('the policy was injected once', () => {
    assert.equal(
      built.split('Content-Security-Policy').length - 1,
      1,
      'a second policy tag would be ignored, and the first would win',
    );
  });
});
