/*
 * Lets `node --test` import `.vue` single-file components directly, and gives
 * each test its own copy of the module graph.
 *
 * Two jobs:
 *
 *   1. Compile a `.vue` file with `@vue/compiler-sfc`. `inlineTemplate: true`
 *      folds the `<template>` into the same module, so the result is one
 *      self-contained file with no second import to resolve.
 *
 *   2. Propagate a `?fresh=N` query down the whole import graph. The sessions
 *      behind `App.vue` are module-level singletons (TODO-048 keeps them
 *      constructible but the app still binds the default instances), so two
 *      tests in one process would otherwise share an outline and a selected
 *      view. Node keys a module by its full URL including the query, so
 *      appending a fresh token to every resolution re-evaluates the entire
 *      graph -- sessions included -- and the tests are genuinely independent
 *      rather than carefully ordered.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileScript, parse } from '@vue/compiler-sfc';

/** The token that marks an import as wanting its own copy of the graph. */
const FRESH = /[?&]fresh=([^&]*)/;

/** Passes a `?fresh=N` down to an import that resolved without one. */
function inheritFresh(url, parentURL) {
  const match = parentURL && FRESH.exec(parentURL);
  if (!match || FRESH.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}fresh=${match[1]}`;
}

export async function resolve(specifier, context, nextResolve) {
  const { parentURL } = context;
  if (specifier.endsWith('.vue')) {
    const from = parentURL ? dirname(fileURLToPath(parentURL)) : process.cwd();
    return {
      url: inheritFresh(
        pathToFileURL(resolvePath(from, specifier)).href,
        parentURL,
      ),
      shortCircuit: true,
      format: 'module',
    };
  }
  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith('file:')) return resolved;
  return { ...resolved, url: inheritFresh(resolved.url, parentURL) };
}

export async function load(url, context, nextLoad) {
  if (!url.includes('.vue')) return nextLoad(url, context);
  const clean = url.split('?')[0];
  const filename = fileURLToPath(clean);
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, {
    id: filename,
    inlineTemplate: true,
  });
  return { format: 'module', shortCircuit: true, source: compiled.content };
}
