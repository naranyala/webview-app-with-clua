# Project overview

## Purpose

This repository is a starter pattern for applications with three deliberately
separated layers:

1. **C** owns native state, validation, and computation.
2. **Lua** provides a compact scripting API for programmatic workflows.
3. **WebView + Octane** provides the desktop presentation layer.

The sample capability is a batch metrics engine. It accepts finite `double`
values and computes sample count, sum, minimum, maximum, arithmetic mean, and
population variance (`M2 / count`, not sample variance).

## User experience

The desktop UI opens on a workspace menu with four tools. The writing flow
starts in **TOC Manager**, where a user declares outline items (title plus
level). Selecting an item opens the **Text Editor** bound to that heading: the
draft is restored, autosaved on every keystroke, and the top bar moves between
neighbouring outline items. All four cards share one persisted record —
written by the native host to `native-workspace/workspace.json`, with
`localStorage` as a boot cache — so the menu badges show live state, outline
items can link to PDF pages and attached images, and a restart restores the
last view, outline, buffer, and reading position.

The native `summarize` binding is still registered by the C host and covered by
the bridge tests, but the current UI no longer renders the metrics form; the
frontend keeps its parsing helpers in `src/metrics-ui.js` for later reuse.

## Scope

This repository demonstrates a narrow integration pattern rather than a
general-purpose analytics product. Workspace persistence is a local JSON file
under the user's data directory; there are no accounts, network services, a
local HTTP server, or a plugin system.

## Current implementation status

Implemented:

- C engine with lifecycle, finite-value validation, overflow rejection, reset,
  and Welford-style stable variance calculation.
- Lua userdata binding with `new`, `add`, `summary`, and `reset`.
- C WebView host with the `summarize` binding.
- Octane frontend compiled into one self-contained HTML file.
- C, bridge, Lua, and sanitizer test entry points.

Known follow-up work is tracked in [`TODOS.md`](../TODOS.md), and every TODO is
linked to an intent in [`PYRAMID-OF-INTENTS.md`](../PYRAMID-OF-INTENTS.md).
