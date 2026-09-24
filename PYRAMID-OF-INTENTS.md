# Pyramid of Intents

This document defines why the project exists, what it must enable, and the
constraints that should guide implementation decisions. `TODOS.md` is the
execution backlog; every backlog item must reference an intent ID from this
document.

## How to use this pyramid

- Keep the intent IDs stable. Add a new intent instead of silently changing
  the meaning of an existing one.
- When proposing work, identify the highest-level intent it serves.
- A TODO is valid only when it has an `Intent:` reference and a verifiable
  outcome.
- If a task conflicts with a higher-level intent, resolve the conflict here
  before implementing it.

## I0 — North-star intent

### I0.1 — Make native capabilities easy to build and easy to use

Provide a small, understandable desktop application pattern in which
performance-sensitive or correctness-critical logic lives in native C, Lua
can orchestrate behavior, and a WebView UI can evolve independently without
losing a simple build and runtime model.

**Success looks like:** a contributor can understand the data flow, run the
tests, launch the desktop app, and safely add a native capability without
rewriting the UI architecture.

## I1 — Product intents

### I1.1 — Demonstrate a useful native capability

The example capability is batch metrics over a finite sequence of numbers.
Users should be able to enter samples and receive a trustworthy summary.

### I1.2 — Make the boundary between UI and native code explicit

The frontend should communicate with native code through a small, documented
bridge. The UI must not depend on implementation details of the C engine.

### I1.3 — Keep the project approachable as a starter template

The project should favor clear code paths, modest dependencies, reproducible
commands, and documentation that matches the code that actually runs.

### I1.4 — Preserve multiple integration surfaces intentionally

Lua remains the scripting/integration surface for programmatic workflows, and
WebView remains the desktop presentation surface. They may share the C core,
but neither should be accidentally presented as the other.

## I2 — User intents

### I2.1 — A user can calculate metrics from the desktop UI

The user enters comma-separated numbers, submits them, and sees count, sum,
mean, variance, minimum, and maximum.

### I2.2 — A user receives useful feedback for invalid input

Empty input, blank tokens, non-numeric values, infinities, and other rejected
requests must produce a clear, actionable message.

### I2.3 — A user can trust the displayed result

The UI must show which calculation was performed, use stable number formatting,
and avoid presenting a partial or stale result as current.

### I2.4 — A developer can run and extend the example quickly

The README, build targets, tests, and source layout should agree on the
supported workflows.

## I3 — System intents

### I3.1 — Keep computation in the C core

The metrics engine owns sample storage, validation, lifecycle, and summary
calculation. It must not depend on Lua, WebView, or frontend concerns.

### I3.2 — Expose a narrow Lua API

Lua receives an owned engine handle with operations to create, add, summarize,
and reset. Native memory must be released through the userdata lifecycle.

### I3.3 — Expose a narrow WebView API

The desktop host exposes one stable operation, currently `summarize`, accepting
the WebView-generated request shape and returning structured JSON.

### I3.4 — Make failures bounded and observable

Malformed requests, non-finite values, empty datasets, allocation failures, and
frontend bridge failures should fail without leaks or undefined behavior and
should provide enough information to diagnose the problem.

### I3.5 — Keep the desktop artifact self-contained

The production frontend should build to a single HTML file with inlined assets,
so the WebView host does not require a local HTTP server or asset directory.

## I4 — Quality and evolution intents

### I4.1 — Test behavior at each boundary

The C core, Lua binding, WebView request parser, and frontend interaction should
have proportionate automated or repeatable verification.

### I4.2 — Prefer numerically sound statistics

The implementation should remain correct for ordinary inputs and should avoid
avoidable precision loss, overflow, and negative-zero surprises as the example
becomes more realistic.

### I4.3 — Make compatibility and dependency assumptions explicit

Supported Lua versions, WebView versions, platform requirements, Node tooling,
and network requirements for first-time builds should be documented and checked.

### I4.4 — Keep the architecture replaceable at the seams

The metrics engine, Lua wrapper, bridge protocol, and frontend should be
changeable independently behind small contracts.

## Current state snapshot

Already present:

- C metrics engine with lifecycle, validation, reset, and summary operations.
- Lua userdata binding and Lua convenience wrapper.
- C WebView host with a `summarize` bridge.
- Octane frontend integrated with the bridge and single-file build.
- C unit test and Lua integration test scaffolding.

Known gaps:

- Full Lua test execution depends on installed Lua development metadata.
- The frontend has build/format checks but no browser behavior test runner.
- The desktop frontend-to-C path lacks an automated GUI smoke test.
- Bridge output is structured, but response-buffer truncation and frontend
  component-level interaction coverage still require explicit tests.
- The desktop build fetches WebView through CMake on first use.
- The frontend cannot calculate in a normal browser preview without the native
  bridge, by design.
