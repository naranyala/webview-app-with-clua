# Documentation

The working documentation for this project. The root
[`README.md`](../README.md) is the short entry point — what this is, how to build
it, and where everything lives. These pages go deeper.

If you only read one of these, read [the intent pyramid](../PYRAMID-OF-INTENTS.md).
It states what the project is for, the constraints that follow from that, and —
importantly — a **current state snapshot** that was checked against the tree rather
than written from memory.

## Guides

| Guide | Read it when you want to know |
| --- | --- |
| [Overview](overview.md) | Why the project exists, what it does, and what it deliberately does not do |
| [Architecture](architecture.md) | Which module owns which responsibility, and what happens at runtime |
| [Bridge protocol](bridge-protocol.md) | What each of the 14 native bindings accepts and returns, and how failures are worded |
| [Development](development.md) | What to install, what to run, what gets built where, and what to do when it breaks |
| [Frontend](frontend.md) | The module graph, the pane components, the stylesheet, and the single-file build |
| [Testing](testing.md) | Every test layer, what each one actually proves, and how to run the lot |
| [Map sources](map-sources.md) | Tile hosts, the rate floor, attribution, and the licensing position |

## Planning

| Document | What it is |
| --- | --- |
| [Intent pyramid](../PYRAMID-OF-INTENTS.md) | The constraints a change must respect, and the verified current state |
| [TODOs](../TODOS.md) | The backlog. Every item carries an `Intent:` reference and a testable outcome |

## How these documents are kept honest

Documentation drifts because nothing fails when it becomes wrong. Three tests in
the frontend suite exist purely to turn silent mismatches into red ones, and they
are worth knowing about before editing any of the pages above:

| Test | What it catches |
| --- | --- |
| `tests/menu-cards.test.js` | The launcher, the static shell, the view list, and the smoke check disagreeing about how many tools there are — and a component a template renders without importing it, which Vue silently renders as an unknown element |
| `tests/bridge-bindings.test.js` | A binding registered in `webview_app.c` that the protocol does not document, and a binding the protocol claims that the host does not register |
| `tests/readme-map.test.js` | A source file missing from the README's repository map, a map entry pointing at a deleted file, and a C suite that is in neither `tests/MANIFEST` nor the map |

Two further checks live inside `static-shell.test.js`: that the stylesheet's
`@import` list covers every partial in the right order, and that the concatenated
stylesheet is not truncated at either end.

## The rule

**When behaviour changes, update the guide and the test in the same change.** The
bridge protocol, the supported commands, and the frontend's module graph are the
three places where a stale document sends someone confidently in the wrong
direction; those are especially worth the extra minute.
