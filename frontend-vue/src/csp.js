/*
 * The Content-Security-Policy the built page ships with.
 *
 * docs/map-sources.md names the tile hosts the app is allowed to contact, and
 * until now nothing enforced it: the page could reach any origin, and the only
 * record of the policy was prose in a document. A policy that exists only in a
 * document is a comment.
 *
 * It lives here rather than hand-written into public/index.html because the
 * allowlist has to agree with the code that builds tile URLs, and a list typed
 * into an HTML file drifts from the session modules the first time a layer is
 * added. TILE_HOSTS is the one place both read from, so they cannot disagree.
 *
 * Free of build-time state, so importing it prints exactly what the policy is -
 * which is what tests/csp.test.js asserts. The hashes are the exception, and they
 * come from plugins/single-file-html.js, which is the only place that sees the
 * built bytes.
 */

/*
 * The tile hosts. default-src 'self' covers everything else the app needs: the
 * script, the stylesheet, and the worker all come from the bundle.
 *
 * The Google viewer's endpoint is listed because it is in the code. Whether it
 * should be is TODO-094, and this policy does not pretend the question is settled:
 * dropping the host here without dropping the tile URL would break the viewer,
 * while keeping the URL and dropping the host would break it more quietly - a
 * viewer showing a grey grid with nothing to say why.
 */
export const TILE_HOSTS = ['tile.openstreetmap.org', 'mt1.google.com'];

/*
 * data: is needed for the placeholder a tile shows while the rate floor holds it
 * back, and for the GeoJSON export's object URL. blob: covers PDF.js, which loads
 * its worker and document bytes through one.
 */
const IMAGE_SOURCES = ["'self'", 'data:', 'blob:', ...TILE_HOSTS];

/*
 * connect-src stays 'self' on purpose. The map fetches tiles through <img>, not
 * fetch(), so the tile hosts do not belong here - and that is the point. If
 * TODO-036 moves tile fetching behind the native bridge, the bridge is same-origin
 * and this line needs no change. A tile host appearing in connect-src would mean
 * something had started calling fetch() against a third party, which is exactly
 * what I1.2 exists to prevent.
 */
export const CSP_DIRECTIVES = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'", "'wasm-unsafe-eval'"]],
  ['style-src', ["'self'", "'unsafe-inline'"]],
  ['img-src', IMAGE_SOURCES],
  /*
   * data: is here for the PDF.js worker, which this build inlines as a base64
   * data: URL (see plugins/single-file-html.js) rather than shipping a second
   * file - which is what keeps the artifact a single self-contained document.
   * blob: is for the runtime cases the same library uses for larger documents.
   */
  ['worker-src', ["'self'", 'data:', 'blob:']],
  ['connect-src', ["'self'"]],
  /* No <object>, <embed>, or <applet> anywhere in this app. */
  ['object-src', ["'none'"]],
  ['frame-src', ["'none'"]],
  ['base-uri', ["'none'"]],
];

/*
 * The inline script and style bodies the production build writes into the single
 * HTML file.
 *
 * This is why script-src is not simply 'self'. The build inlines the whole bundle
 * into one <script>, and an inline script without a matching hash is blocked - the
 * app would not start at all, which is the same failure as shipping a policy that
 * cannot be satisfied. Hashing the bodies keeps 'unsafe-inline' out of script-src;
 * without that, the policy would permit any injected inline script, which is most
 * of what a CSP exists to prevent.
 *
 * style-src keeps 'unsafe-inline' rather than a hash, because Vue writes style
 * attributes at runtime for the tile layer transforms and the marker positions -
 * they are not in the built document to be hashed. That is a real gap, recorded
 * rather than papered over: it means an injected style attribute can still apply.
 */
export function withInlineHashes(hashes = {}) {
  const directives = CSP_DIRECTIVES.map(([name, sources]) => {
    if (name !== 'script-src') return [name, sources];
    return [name, [...sources, ...(hashes.script ?? [])]];
  });
  return directives;
}

/* The full policy value, directives in order. */
export function buildCsp(directives = CSP_DIRECTIVES) {
  return directives
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/*
 * The meta tag as it appears in the document.
 *
 * A meta policy is weaker than a header: it cannot carry frame-ancestors or
 * report-uri, and it does not govern requests the browser made before parsing it.
 * It is the only form that survives being inlined into one self-contained HTML
 * file, which is what the desktop host loads, so it is what ships - with the
 * weaker-than-ideal form written down here instead of being implied to be a
 * header.
 */
export function cspMetaTag(directives = CSP_DIRECTIVES) {
  return `<meta http-equiv="Content-Security-Policy" content="${buildCsp(directives)}" />`;
}
