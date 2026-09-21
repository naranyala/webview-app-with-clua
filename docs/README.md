# Documentation

This directory contains the working documentation for the project. The root
[`README.md`](../README.md) is the short entry point; these pages describe the
system in enough detail to build, test, modify, and extend it.

## Guides

- [Overview](overview.md) — purpose, scope, and current behavior.
- [Architecture](architecture.md) — components, ownership, and runtime flows.
- [Bridge protocol](bridge-protocol.md) — WebView-to-C request and response
  contract.
- [Development](development.md) — prerequisites, commands, and troubleshooting.
- [Frontend](frontend.md) — Octane structure, build output, and UI behavior.
- [Testing](testing.md) — test layers, coverage, and verification commands.

## Planning

- [Pyramid of intents](../PYRAMID-OF-INTENTS.md) — why the project exists and
  the constraints that guide changes.
- [TODOs](../TODOS.md) — intent-linked implementation backlog.

## Documentation rule

When behavior changes, update the relevant guide and tests in the same change.
The bridge protocol, supported commands, and active frontend path are
especially important: documentation must describe the code that actually runs.
