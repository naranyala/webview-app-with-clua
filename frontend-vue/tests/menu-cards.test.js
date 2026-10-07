/*
 * The launcher menu and the smoke check cannot disagree.
 *
 * `src/smoke.js` asserts a card count and a set of pane anchors against the real
 * rendered app, but it only runs where a graphical session exists (`make
 * smoke-test`). That is precisely why the count sat at 5 while the launcher
 * rendered 6 for as long as it did: the one place that compared them was the one
 * place CI does not run, so the disagreement was invisible here and would have
 * failed on a developer's desktop instead.
 *
 * This file makes the same comparison in the ordinary test run, over the two
 * sources of truth - MenuView.vue, which the app actually renders, and
 * public/index.html, the static shell the smoke run falls back to.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { EXPECTED_MENU_CARDS, REQUIRED_ANCHORS } from '../src/smoke.js';
import { VIEWS } from '../src/workspace.js';

const menuView = readFileSync(
  new URL('../src/components/MenuView.vue', import.meta.url),
  'utf8',
);
const staticShell = readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8',
);
const smoke = readFileSync(new URL('../src/smoke.js', import.meta.url), 'utf8');

const COMPONENT_FOR_TOOL = {
  editor: 'EditorPane.vue',
  toc: 'TocPane.vue',
  pdf: 'PdfPane.vue',
  images: 'ImagesPane.vue',
  map: 'MapPane.vue',
  googlemap: 'GoogleMapPane.vue',
};

const cardIds = (source) =>
  [...source.matchAll(/data-app="([a-z]+)"/g)].map((match) => match[1]);

const TOOL_VIEWS = VIEWS.filter((view) => view !== 'menu');

test('the launcher renders one card per tool view', () => {
  /*
   * Compared as sets, not in order. MenuView.vue puts TOC Manager first because
   * the writing flow starts there, while VIEWS lists 'editor' first for
   * alphabetical tidiness in the schema; requiring the same order would be a
   * constraint about nothing. What must match is which tools exist.
   */
  assert.deepEqual(
    [...cardIds(menuView)].sort(),
    [...TOOL_VIEWS].sort(),
    'MenuView.vue must render a card for every view the workspace knows',
  );
  /* And a tool must not appear twice - which a set comparison would hide. */
  const ids = cardIds(menuView);
  assert.equal(
    new Set(ids).size,
    ids.length,
    `duplicate card: ${ids.join(', ')}`,
  );
});

test('the static shell renders the same cards as the component', () => {
  assert.deepEqual(
    [...cardIds(staticShell)].sort(),
    [...cardIds(menuView)].sort(),
    'public/index.html is the shell the smoke run falls back to; it cannot show a different menu',
  );
});

test('the smoke check expects the card count the menu actually renders', () => {
  assert.equal(
    EXPECTED_MENU_CARDS,
    cardIds(menuView).length,
    'smoke.js would fail against the app it is checking',
  );
  /* And the constant the source declares agrees with the exported one, so the
     number cannot be edited in one place and not the other. */
  assert.match(
    smoke,
    new RegExp(`EXPECTED_MENU_CARDS = ${EXPECTED_MENU_CARDS};`),
  );
});

/*
 * The root class of each pane, which is what the smoke run looks for.
 *
 * Written out rather than derived from the component files: the point is to check
 * the smoke list against what the app renders, and a test that reads the same
 * source it is checking cannot disagree with it. The TOC pane is `.toc-manager`
 * rather than a `-app` name like the rest, which is exactly the kind of
 * irregularity a suffix-matching heuristic would have hidden.
 */
const PANE_ROOT_CLASS = {
  editor: '.editor-app',
  toc: '.toc-manager-toolbar',
  pdf: '.pdf-app',
  images: '.image-app',
  map: '.map-app',
  googlemap: '.google-map-app',
};

test('the smoke check looks for a pane anchor for every card', () => {
  /*
   * The anchors were the other half of the same gap: six cards with five pane
   * anchors would pass the count check and then say nothing about the sixth tool.
   * A card whose pane the smoke run never looks for is a card the smoke run
   * cannot report on.
   */
  for (const [tool, selector] of Object.entries(PANE_ROOT_CLASS)) {
    assert.ok(
      cardIds(menuView).includes(tool),
      `${selector} is checked but there is no card for "${tool}"`,
    );
    assert.ok(
      REQUIRED_ANCHORS.includes(selector),
      `the card for "${tool}" has no smoke anchor; add ${selector}`,
    );
  }
  /* And every pane component actually renders the class the smoke run looks for,
     read from the component so a renamed root class is caught here rather than
     only on a desktop with a display attached. */
  for (const [tool, selector] of Object.entries(PANE_ROOT_CLASS)) {
    const file = COMPONENT_FOR_TOOL[tool];
    assert.match(
      readFileSync(
        new URL(`../src/components/${file}`, import.meta.url),
        'utf8',
      ),
      new RegExp(`class="[^"]*${selector.slice(1)}`),
      `${file} does not render ${selector}, which the smoke run looks for`,
    );
  }
});

const BUILTIN_COMPONENTS = new Set([
  'Teleport',
  'Suspense',
  'KeepAlive',
  'Transition',
  'TransitionGroup',
  'component',
  'slot',
  'template',
]);

test('every component a template uses is imported into that component', () => {
  /*
   * The failure this exists to catch, and did not.
   *
   * Six pane components used `<StatusLine>` without importing it. Vue does not
   * report an unresolved component: it renders an unknown element, so
   * `<StatusLine :message="m" />` became `<statusline message="m">` - the message
   * became an *attribute* instead of text. Every status line in every pane was
   * showing the reader nothing, and announcing nothing, because the `role="status"`
   * and `aria-live` the component carries never rendered.
   *
   * It survived because the shell tests assert that status ids and anchors exist,
   * and `<statusline>` has them. Nothing asserted that the element was the right
   * one. This checks the import instead, which is the actual cause rather than the
   * symptom.
   */
  const components = readdirSync(
    new URL('../src/components/', import.meta.url),
  ).filter((entry) => entry.endsWith('.vue'));
  for (const file of components) {
    const source = readFileSync(
      new URL(`../src/components/${file}`, import.meta.url),
      'utf8',
    );
    /* `[, name]` not `[name]`: destructuring index 0 gives the whole match,
       including the angle bracket, which is how this first reported `<S`. */
    for (const [, name] of source.matchAll(/<([A-Z][A-Za-z]*)(\s|>|\/)/g)) {
      /* Vue's built-ins need no import. */
      if (BUILTIN_COMPONENTS.has(name)) continue;
      assert.match(
        source,
        new RegExp(`^import ${name} from`, 'm'),
        `${file} renders <${name}> but never imports it, so Vue will render an unknown element`,
      );
    }
  }
});

test('every view a card names is one the workspace can restore', () => {
  /* The link between the two lists that has no other check: a card for a view
     `normalizeWorkspace` would reject on restore is a card that opens a pane and
     then loses the selection on the next restart. */
  for (const id of cardIds(menuView)) {
    assert.ok(
      VIEWS.includes(id),
      `MenuView.vue has a card for "${id}", which is not a known view`,
    );
  }
});
