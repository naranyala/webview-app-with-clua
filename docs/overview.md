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

The desktop UI starts with example values in a bare-minimum text editor. A user
can replace them, select **Run metrics** from the top toolbar or right-side
vertical toolbar, and inspect the native summary in the output panel. The
frontend shows a loading state while the request crosses the WebView bridge,
then renders the native summary or a useful error.

The ordinary frontend development server is useful for layout work, but it
does not provide the native bridge. In that mode, submitting the form reports
that the desktop bridge is unavailable.

## Scope

This repository demonstrates a narrow integration pattern rather than a
general-purpose analytics product. It does not currently provide persistence,
accounts, network services, a local HTTP server, or a plugin system.

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
