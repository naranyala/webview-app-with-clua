# Project overview

## Purpose

This repository is a **reference implementation of a desktop application pattern**,
not a product. It exists to answer one question clearly:

> How do you put correctness-critical state and computation in C, keep two
> different presentation surfaces on top of it, and have the boundary between them
> stay honest as the application grows?

Three layers, deliberately separated:

1. **C** owns native state, validation, computation, and persistence.
2. **Lua** is a compact scripting surface for programmatic workflows.
3. **WebView + Vue** is the desktop presentation layer.

The sample capability is a batch metrics engine: it accepts finite `double`
values and returns count, sum, minimum, maximum, arithmetic mean, and population
variance (`M2 / count`, not the sample variance). It is computed with Welford's
algorithm, so the running mean and second moment never depend on a running sum
that has already lost its low-order bits.

## The shape of the claim

Two properties make this a pattern rather than an app:

**The boundary is checkable, not aspirational.** The page makes no `fetch()` calls
at all. Everything the UI cannot do on its own, it asks the host for through one
of 14 documented bindings, and gets back structured JSON or a typed error. You
can verify that claim with `grep`.

**Durability is the host's job, not the browser's.** Workspace state is written by
C to a file, atomically. WebView `localStorage` is a boot cache, not the record —
which matters because the default inline render mode does not persist WebView
storage at all, so an app that trusted it would lose everything on exit.

## The user experience

The desktop UI opens on a menu of six tools over one shared record.

The writing flow starts in **TOC Manager**, where a reader declares outline items
(title plus level). Selecting an item opens the **Text Editor** bound to that
heading: the draft is restored, saved on every keystroke, and the top bar moves
between neighbouring items. Items link outward — to a **PDF Reader** page, to
images in the **Image Viewer**, to a saved place on the **Map Explorer**.

All six cards read and write one record, so the menu badges show live state and a
restart restores the last view, the outline, the open drafts, the reading position,
and the image selection.

### The two map tools

**Map Explorer** is a hand-written OpenStreetMap tile canvas — no mapping library.
Pan, zoom, a colour filter and a renderer switch, saved places, distance and
bearing between them, and locate. It loads tiles **from the page**, which is the
one place the boundary is not held; see the gaps below.

**Google Maps** is a second, render-only tile viewer with a layer selector, Google
Maps URL parsing, and GeoJSON export. **It is unlicensed**: it fetches from
Google's internal raster endpoint with no API key and no Maps Platform agreement.

## What this project is not

It is not an analytics product, and the metrics engine is not the point.

- No accounts, no network services, no local HTTP server, no plugin system.
- Workspace persistence is a local JSON file under the user's data directory.
- `summarize` — the headline native capability — **has no production UI caller**.
  It exists for the Lua example, the bridge tests, and the desktop smoke test. That
  is acceptable for a starter whose subject is the pattern rather than the
  calculator, but it should be a decision rather than an accident, so it is stated
  here, in the README, and in the architecture guide.

## Current state

Verified against the tree and a full test run, rather than written from memory. The
authoritative version, with dates and the reasoning behind each entry, is the
[current state snapshot](../PYRAMID-OF-INTENTS.md#current-state-snapshot) in the
intent pyramid.

Implemented and working:

- The C metrics engine, the Lua binding, and the C WebView host with its 14
  bindings.
- A six-tool Vue frontend, one component per pane, built to a single self-contained
  HTML file with an injected Content-Security-Policy.
- A durable C-owned workspace store: atomic rename, 4 MiB cap, no silent data loss.
- 11 C suites declared once in `tests/MANIFEST` and read identically by `make`,
  `build.lua`, and CMake; plus the Lua suite and 33 frontend suites.

The gaps worth knowing before you build on it:

| Gap | Why it matters |
| --- | --- |
| The Map Explorer fetches tiles from the page | The one crossing of the boundary the rest of the app holds. TODO-035, TODO-036 |
| The Google viewer uses an unlicensed endpoint | Named in the shipped CSP because that is a statement about reachability, not permission. TODO-094 |
| The GUI smoke test needs a graphical session, and CI has no workflow for it | The gap that let the menu-card count drift while the app disagreed with its own check |
| No mounted component tests for the map, reader, or lightbox | The map has extensive session-level tests; the panes do not have jsdom coverage |

Known follow-up work is tracked in [`TODOS.md`](../TODOS.md), and every item there
is linked to an intent in
[`PYRAMID-OF-INTENTS.md`](../PYRAMID-OF-INTENTS.md).
