# Lua examples

Two runnable examples, both going through the same C engine:

- `demo.lua` — the binding on its own: build an engine from numbers, read the
  summary table back, and print it.
- `ui.lua` — the smallest possible WebView surface. It returns one HTML string
  whose button calls `window.summarize(...)`, which is the whole frontend-to-C
  contract in a single page. It exists to show that the bridge needs nothing
  from the build; the desktop UI itself is `frontend-vue/`.

```sh
lua build.lua native
lua examples/demo.lua          # via: make run
```

`ui.lua` is not loaded by any build target or by the desktop app — print it
yourself (`lua -e "print(require('examples.ui'))"`) if you want to see it.
