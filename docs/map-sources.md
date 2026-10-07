# Map Sources, Limits, and Attribution

## OpenStreetMap Explorer

### Tile layers

| Layer | URL pattern | Description |
|-------|-------------|-------------|
| Standard | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Default OSM raster tiles |

### Host allowlist

Only `tile.openstreetmap.org` is fetched. No other tile host is contacted.

This is enforced, not just documented: `src/csp.js` builds a
`Content-Security-Policy` whose `img-src` is limited to the hosts listed in
`TILE_HOSTS`, and `plugins/single-file-html.js` injects it into the built
`dist/index.html`. The allowlist is generated from the same constant the map
sessions build URLs from, so the two cannot drift; `tests/csp.test.js` fails if a
tile host is reachable but unnamed, or named but unreachable.

`connect-src` is deliberately `'self'` and lists no tile host. Tiles are fetched
through `<img src>`, not `fetch()`, so `img-src` is the directive that governs
them — and a third-party host appearing in `connect-src` would mean something had
started calling `fetch()` against a third party, which is the crossing **I1.2**
exists to prevent.

### Rate floors

| Request type | Minimum interval | Notes |
|-------------|-----------------|-------|
| Tile fetch | 200 ms | Token bucket; `TILE_BURST` (8) requests may start at once |
| Search (Nominatim) | 1000 ms | When search is wired through native host |

The floor is a **token bucket** in the explorer session, not a wait between
requests. `TILE_BURST` (8) requests may start immediately — the first screenful —
and after that one slot opens per floor interval, refilling to the burst ceiling
rather than accumulating. A bare wait with no burst would admit one tile per
interval, so a full screen of roughly twenty tiles would take four seconds to
draw: the floor behaving as written and the map behaving as unusable.

Admission is centre-outward: the tiles nearest the middle of the screen go first,
because that is what the reader is looking at and the buffer ring exists to cover
a pan that may never happen. An admitted tile stays admitted for the life of the
session, so panning back over ground already fetched costs no request at all.

The floor is set by the `rateFloorMs` option to `createMapExplorer()`, which
defaults to `DEFAULT_RATE_FLOOR_MS` (200). **There is no `TILE_RATE_FLOOR_MS`
environment variable** — an earlier version of this document claimed one and no
code has ever read it.

### The published limit does not match the floor

This document previously derived "~2 requests/second" from a 200 ms floor. The
arithmetic does not agree: 200 ms is 5 per second. The floor is left at 200 ms
because it is the number the code and the constructor signature already promise,
and because the bucket is what bounds a burst rather than the interval being the
whole mechanism. Reconciling the published figure with the OSM tile usage policy
is TODO-041's work, and until then **the number in the policy section below
should be read as an intention rather than as something the code measures.**

### Escape hatch for high demand

If tile demand exceeds the OSM tile usage policy:

1. **Self-hosted tile server**: Point `tileUrl` at your own tile server
   (e.g., OpenMapTiles, Tegola). The URL pattern must match
   `https://{host}/{z}/{x}/{y}.png`.
2. **MBTiles**: Pre-download tiles for your region of interest and serve
   them locally. The app can be configured to read from a local MBTiles
   file via a custom `tileUrl` function.
3. **Commercial tile providers**: Use a provider with a license that
   permits your usage level (e.g., Mapbox, Google Maps via API).

### Attribution

```
© OpenStreetMap contributors
```

The attribution is rendered in the map footer and must remain visible
per the OSM tile usage policy.

### Tile usage policy compliance

- Maximum ~2 requests/second sustained — **not enforced at that figure today.**
  The 200 ms floor is 5/second; the bucket bounds the burst, not the sustained
  rate. Reconciling this line with the OSM policy is TODO-041.
- No bulk downloading — enforced in the sense that matters: a tile reaches the
  network only once the bucket admits it, so a fast zoom or a flight cannot issue
  a request per frame.
- Identifying User-Agent required (set by the native host when tiles
  are fetched through `fetchMapTile`; the page-side fetch uses the
  browser's default User-Agent) — **still unmet page-side**, and it is part of
  what TODO-036's native transport exists to fix.
- Cache tiles locally when possible (the app caches decoded bitmaps
  in memory; a disk cache is planned via TODO-036)

## Google Maps Viewer (sixth grid tool)

### Tile layers

| Layer | URL pattern | Description |
|-------|-------------|-------------|
| Road | `https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}` | Standard road map |
| Satellite | `https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}` | Satellite imagery |
| Hybrid | `https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}` | Satellite + labels |
| Terrain | `https://mt1.google.com/vt/lyrs=t&x={x}&y={y}&z={z}` | Terrain map |

### Host allowlist

Only `mt1.google.com` is fetched. No other Google tile host is contacted, and it
is named in the same `img-src` allowlist as the OSM host (see above).

**This host is not covered by a licence.** `mt1.google.com/vt/lyrs=` is Google's
internal raster endpoint, used here with no API key and no Google Maps Platform
agreement, which contradicts the escape-hatch note above recommending a provider
that permits your usage level. TODO-094 is the open decision: drop this viewer,
move the URL into configuration, or gate it behind an explicit opt-in. Until then
it is listed in the policy because it is in the code, and being in a policy is not
the same as being permitted. It is also the reason `docs/frontend.md` describes
this viewer as **unlicensed** wherever it names the endpoint.

### Rate floors

| Request type | Minimum interval | Notes |
|-------------|-----------------|-------|
| Tile fetch | 200 ms | Same bucket as OSM |

**Enforced here too, as of TODO-093.** The bucket used to exist only in
`map-explorer.js`, so this viewer fetched as fast as the DOM asked while this
document claimed it did not. Both viewers now compose one `createMapViewport()`
in `map-viewport.js`, so the floor above is one implementation rather than a
promise about two.

### Attribution

```
Google Maps
```

The attribution is rendered in the map footer.

### API key

No API key is used. Tiles are fetched from Google's public tile servers, which
do not require authentication. This is a render-only viewer — no Google Maps
JavaScript API is used. See the licence note above: "requires no key" is not the
same as "permitted".

## Content-Security-Policy

`src/csp.js` holds the policy and `plugins/single-file-html.js` injects it into
`<head>` of the built `dist/index.html`. The shipped value:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-…';
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:
tile.openstreetmap.org mt1.google.com; worker-src 'self' data: blob:;
connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'
```

Three things in it are worth knowing before changing it:

- **`script-src` carries a hash, not `'unsafe-inline'`.** The build inlines the
  whole bundle into one `<script>`, so `script-src 'self'` alone blocks the only
  script there is and the app never starts. `plugins/single-file-html.js` hashes
  the inline body and injects the digest; `tests/csp.test.js` recomputes it from
  `dist/index.html` so a change to that hashing fails in the suite rather than in
  the desktop host.
- **`style-src` keeps `'unsafe-inline'` and cannot do otherwise.** Vue writes
  `style` attributes at runtime for the tile-layer transforms and the marker
  positions; they are not in the built document to be hashed. An injected style
  attribute can therefore still apply.
- **It is a `<meta>` policy, not a header.** It cannot carry `frame-ancestors`,
  and it does not govern requests the browser made before parsing it. It ships as
  a meta tag because that is the only form that survives being inlined into the
  single self-contained HTML file the desktop host loads.

## Native host bindings (not yet planned)

**No map binding exists.** `src/webview_app.c` registers 14 bindings and none of
them is a map binding, so the entire map stack is the one part of this app that
touches the network from the page.

Everything below is the **shape of the work**, not a commitment. Two corrections to
the earlier version of this section, because both were wrong in a way that would
have sent someone looking for code that does not exist:

- **`searchMapPlaces` should not be listed at all.** The Explorer has no place
  search — not implemented, not stubbed, not present in the backlog as a *feature*.
  It was briefly written up as planned and as shipped, and both were untrue; the
  item is tracked honestly now as TODO-038, reopened for that reason. If a search is
  wanted, the place to put it is Nominatim via the native host, which is also the
  only version of it that obeys its usage policy.
- **`locateMapPlace` and libcurl/GeoClue2 are speculation.** The location feature
  that exists today, `geo-locate.js`, uses the browser's own
  `navigator.geolocation` and needs no native binding. Replacing it with GeoClue2
  would be a *downgrade* in portability for no stated reason, so it is not a step
  worth naming in advance.

What TODO-035 and TODO-036 actually cover is narrower: moving **tile fetching**
across the boundary so the page stops making third-party requests. The design
constraints are real even if the API is not:

- HTTPS only, with a custom User-Agent — OSM's tile usage policy requires an
  identifying one.
- A per-request timeout and a size cap, so a slow or hostile response cannot stall
  the map.
- The rate floors in this document enforced in C, where they cannot be bypassed by
  any renderer.
- A disk cache with LRU eviction, and caching that moves at the platform layer —
  once the host fetches tiles, the `<img>` element no longer owns the HTTP cache.

Until then the allowlist above is the whole of the enforcement, and it is
enforcement of *reachability* rather than of *permission*.
