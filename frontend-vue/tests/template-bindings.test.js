/*
 * Static test: every identifier the template references must resolve to a
 * script-setup binding.
 *
 * The template and the script-setup block share one scope, but neither the
 * Vue compiler nor Biome reports an unknown template identifier. Compiling the
 * template with prefixed identifiers turns every reference into `_ctx.name`,
 * which can be checked against the bindings Vue itself resolved.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');

const templateGlobals = new Set([
  '$attrs',
  '$emit',
  '$event',
  '$forceUpdate',
  '$nextTick',
  '$refs',
  '$slots',
]);

test('Every template identifier resolves to a script-setup binding', () => {
  const { descriptor, errors } = parse(source, { filename: 'App.vue' });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.scriptSetup, 'App.vue must keep a script setup block');

  const script = compileScript(descriptor, { id: 'app' });
  const bindings = new Set(Object.keys(script.bindings));

  const { code, errors: templateErrors } = compileTemplate({
    source: descriptor.template.content,
    filename: 'App.vue',
    id: 'app',
    compilerOptions: { prefixIdentifiers: true, mode: 'module' },
  });
  assert.deepEqual(templateErrors, []);

  const referenced = [
    ...new Set(
      [...code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]),
    ),
  ].filter((name) => !templateGlobals.has(name));

  for (const name of [
    'selectView',
    'countWords',
    'documentTitle',
    'workspaceReport',
    'openPdfAt',
    'openImageDirectoryAt',
    'pdfRecentPaths',
    'imageRecentPaths',
  ]) {
    assert.ok(referenced.includes(name), `template never used ${name}`);
  }

  const missing = referenced.filter((name) => !bindings.has(name));
  assert.deepEqual(
    missing,
    [],
    `template references with no script-setup binding: ${missing.join(', ')}`,
  );
});
