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

/*
 * A second wiring check, for the imports rather than the template.
 *
 * This resolves each session module for real and checks that every name App.vue
 * imports from it is actually exported, which catches a rename or a removal on
 * either side of an import statement.
 *
 * The other direction - a name used in the script and never imported - is not
 * checkable this way, and is covered by biome's noUndeclaredVariables rule
 * instead. Neither check was here when a missing `mapPlacesSnapshot` reached a
 * build: every test passed, the app mounted, and only the smoke run reported it.
 */
test('every session import in App.vue is really exported', async () => {
  const source = readFileSync(
    new URL('../src/App.vue', import.meta.url),
    'utf8',
  );
  const imports = [
    ...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)';/g),
  ].map((match) => ({
    names: match[1]
      .split(',')
      .map((name) =>
        name
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean),
    specifier: match[2],
  }));

  assert.ok(imports.length >= 8, `found ${imports.length} session imports`);

  const problems = [];
  for (const entry of imports) {
    /* Components are .vue files, which node cannot import. */
    if (entry.specifier.endsWith('.vue')) continue;
    const module = await import(
      new URL(`../src/${entry.specifier.slice(2)}`, import.meta.url)
    );
    for (const name of entry.names) {
      if (!(name in module)) {
        problems.push(`${entry.specifier} does not export ${name}`);
      }
    }
  }

  assert.deepEqual(problems, [], problems.join('; '));
});
