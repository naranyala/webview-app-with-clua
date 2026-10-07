/*
 * Static test: every identifier a template references must resolve to a
 * script-setup binding, in every component.
 *
 * The template and the script-setup block share one scope, but neither the Vue
 * compiler nor Biome reports an unknown template identifier. Compiling the template
 * with prefixed identifiers turns every reference into `_ctx.name`, which can be
 * checked against the bindings Vue itself resolved.
 *
 * This used to read only App.vue, which was correct when App.vue held the shell and
 * all six panes' markup. It now walks the component directory, because the check
 * that catches a typo'd binding has to follow the templates when they move — and
 * two real bugs were sitting in this gap: `mapSize` and `googleMapCenter` were
 * referenced by a template and never imported, so Vue resolved them to `undefined`.
 * The Google viewer's centre label rendered "No location" because of it, and the
 * GeoJSON overlay's `viewBox` was `0 0 undefined undefined`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

const COMPONENT_DIR = new URL('../src/components/', import.meta.url);
const APP = new URL('../src/App.vue', import.meta.url);

/* Every .vue file the shell renders from: App.vue plus the component directory. */
function components() {
  const files = [APP];
  for (const entry of readdirSync(COMPONENT_DIR)) {
    if (entry.endsWith('.vue')) files.push(new URL(entry, COMPONENT_DIR));
  }
  return files;
}

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
  const problems = [];

  for (const file of components()) {
    const source = readFileSync(file, 'utf8');
    const { descriptor, errors } = parse(source, { filename: file.pathname });
    if (errors.length) {
      problems.push(`${file.pathname}: ${errors.join('; ')}`);
      continue;
    }
    if (!descriptor.scriptSetup) {
      problems.push(`${file.pathname}: no script setup block`);
      continue;
    }

    const script = compileScript(descriptor, { id: file.pathname });
    const bindings = new Set(Object.keys(script.bindings));

    const { code, errors: templateErrors } = compileTemplate({
      source: descriptor.template.content,
      filename: file.pathname,
      id: file.pathname,
      compilerOptions: { prefixIdentifiers: true, mode: 'module' },
    });
    if (templateErrors.length) {
      problems.push(`${file.pathname}: ${templateErrors.join('; ')}`);
      continue;
    }

    const missing = [
      ...new Set(
        [...code.matchAll(/_ctx\.([A-Za-z_$][\w$]*)/g)].map(
          (match) => match[1],
        ),
      ),
    ]
      .filter((name) => !templateGlobals.has(name))
      .filter((name) => !bindings.has(name));

    if (missing.length) {
      problems.push(`${file.pathname}: ${missing.join(', ')}`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

/*
 * The shell must still *use* these, not merely declare them somewhere: the pane
 * extraction moved every one of them into a component, and a check that only
 * asserted "the name resolves" would pass on a template that had quietly stopped
 * rendering the control.
 */
test('the shell still renders its status bar, badges, and menu wiring', () => {
  const app = readFileSync(APP, 'utf8');
  for (const name of [
    'selectView',
    'workspaceReport',
    'persistenceMode',
    'editorBadge',
    'pdfBadge',
    'imagesBadge',
    'outlineBadge',
    'mapBadge',
    'googleMapBadge',
  ]) {
    assert.ok(app.includes(name), `App.vue no longer references ${name}`);
  }
  /* And each pane is mounted, not defined and forgotten. */
  for (const tag of [
    'TocPane',
    'ImagesPane',
    'PdfPane',
    'MapPane',
    'GoogleMapPane',
  ]) {
    assert.ok(app.includes(`<${tag} />`), `App.vue does not mount ${tag}`);
  }
  /* EditorPane is the one pane with a prop, so its tag is not self-closing. */
  assert.ok(
    /<EditorPane\b[^>]*persistence-mode/.test(app),
    'App.vue does not mount EditorPane with its persistence mode',
  );
});

/*
 * A wiring check for the imports, over every component.
 *
 * This resolves each session module for real and checks that every name a
 * component imports from it is actually exported, which catches a rename or a
 * removal on either side of an import statement.
 *
 * The other direction - a name used in the script and never imported - is not
 * checkable this way, and is covered by biome's noUndeclaredVariables rule
 * instead. Neither check was here when a missing `mapPlacesSnapshot` reached a
 * build: every test passed, the app mounted, and only the smoke run reported it.
 */
test('every session import in every component is really exported', async () => {
  const problems = [];
  let importCount = 0;

  for (const file of components()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /import\s*\{([^}]+)\}\s*from\s*'(\.\.?\/[^']+)';/g,
    )) {
      const names = match[1]
        .split(',')
        .map((name) =>
          name
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      /* Components are .vue files, which node cannot import. */
      if (match[2].endsWith('.vue')) continue;
      importCount += 1;
      const module = await import(
        new URL(
          `../src/${match[2].replace(/^\.\.\//, '').replace(/^\.\//, '')}`,
          import.meta.url,
        )
      );
      for (const name of names) {
        if (!(name in module)) {
          problems.push(
            `${file.pathname}: ${match[2]} does not export ${name}`,
          );
        }
      }
    }
  }

  assert.ok(importCount >= 20, `found ${importCount} session imports`);
  assert.deepEqual(problems, [], problems.join('; '));
});
