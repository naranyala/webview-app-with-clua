/*
 * Responsive layout contracts.
 *
 * The stylesheet is one hand-written file, so a column count or a breakpoint is
 * edited in place with no type error and no failing build to notice it. These
 * tests are that missing signal: they pin the breakpoint-to-column mapping for
 * the five real multi-column grids, and they check the arithmetic that decides
 * whether a fixed track can overflow the narrowest supported viewport.
 *
 * Everything here reads `frontend-vue/src/index.css` as text. Nothing renders,
 * so this stays a static contract like the rest of the shell tests; the DOM
 * harness in TODO-017 is where these become measurements.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { VIEWS } from '../src/workspace.js';
import { styles } from './support/styles.mjs';

/*
 * The rules in cascade order. index.css is now an @import list; see
 * tests/support/styles.mjs for why the order lives there rather than being read
 * off disk here.
 */
const source = styles;

/*
 * Comments are stripped first, keeping newlines so line numbers and offsets
 * survive. The sheet argues its layout decisions in prose, and several comments
 * contain a brace and a media query, which would otherwise be parsed as rules.
 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
  comment.replace(/[^\n]/g, ' '),
);

/**
 * The body refuses to render narrower than this, so every track in the sheet
 * has to fit inside it. `index.css` sets it in one place.
 */
const MIN_VIEWPORT = 320;

/**
 * Every rule in the sheet, as `{ selector, body, media }`.
 *
 * Braces are matched rather than regexed so a declaration containing one (there
 * are none today) cannot desynchronise the walk, and so a nested `@media` is
 * attributed to the rule it actually wraps instead of to the nearest preceding
 * `@media` line.
 */
function parseRules() {
  const rules = [];
  const stack = [];
  let selector = '';
  let prelude = '';
  let index = 0;

  const readUntil = (stops) => {
    const at = [...stops]
      .map((stop) => css.indexOf(stop, index))
      .filter((at) => at !== -1);
    const end = at.length ? Math.min(...at) : css.length;
    const text = css.slice(index, end);
    index = end;
    return text;
  };

  while (index < css.length) {
    const text = readUntil(['{', '}', ';']);
    if (index >= css.length) break;
    const delimiter = css[index];
    index += 1;

    if (delimiter === '{') {
      stack.push(prelude.trim());
      prelude = '';
      selector = text.trim();
      if (selector.startsWith('@')) {
        prelude = selector;
        selector = '';
        continue;
      }
      // A plain rule: read its body to the matching close brace.
      let depth = 1;
      const bodyStart = index;
      while (index < css.length && depth > 0) {
        if (css[index] === '{') depth += 1;
        if (css[index] === '}') depth -= 1;
        if (depth === 0) break;
        index += 1;
      }
      const media =
        stack.filter((frame) => frame.startsWith('@media')).pop() ?? null;
      rules.push({
        selector: selector.replace(/\s+/g, ' '),
        body: css.slice(bodyStart, index),
        media: media ? media.replace(/\s+/g, ' ') : null,
      });
      index += 1;
      continue;
    }

    if (delimiter === '}') {
      stack.pop();
      prelude = '';
      continue;
    }

    // A declaration or an at-rule statement, e.g. `@supports (...) {` is handled
    // above; anything else belongs to the current rule's body.
    prelude = '';
  }

  return rules;
}

const RULES = parseRules();

/**
 * Every declaration block naming `selector`, base rules and media rules alike.
 *
 * A selector list counts as naming each of its parts, so a rule written as
 * `.pdf-app, .image-app` is found by either -- which matters because the
 * sidebar tiers deliberately group the two shells.
 */
function blocksFor(selector) {
  return RULES.filter((rule) =>
    rule.selector.split(',').some((part) => part.trim() === selector),
  );
}

/** Resolves one rule's `grid-template-columns` value, if it declares one. */
function columnsOf(selector) {
  return blocksFor(selector).map(({ body, media }) => {
    const match = body.match(/grid-template-columns:\s*([^;]+);/);
    return { value: match ? match[1].trim() : null, media, body };
  });
}

/* The number of tools the grid has to accommodate: every view but the menu. */
const TOOL_COUNT = VIEWS.filter((view) => view !== 'menu').length;

/** `repeat(3, minmax(0, 1fr))` -> 3; `minmax(0, 1fr)` -> 1. */
function trackCount(value) {
  const repeated = value.match(/^repeat\((\d+),/);
  if (repeated) return Number(repeated[1]);
  return value ? 1 : 0;
}

/** The largest pixel literal in a track size, or null when it is fluid. */
function widestTrack(value) {
  const px = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  return px.length ? Math.max(...px) : null;
}

test('the menu grid lays out one column per tool, then 3 / 2 / 1', () => {
  const rules = columnsOf('.app-grid').filter((rule) => rule.value);
  assert.equal(
    rules.length,
    4,
    'the menu grid has a base rule and three tiers',
  );

  const byMedia = new Map(rules.map((rule) => [rule.media, rule]));
  /*
   * One column per tool on a wide window, and checked against the card count
   * rather than a literal. The literal was 5 while the grid declared 6, which is
   * the same drift as everywhere else in this area - and a hardcoded number here
   * is a number that has to be edited every time a tool is added. tests/
   * menu-cards.test.js owns the count; this owns that the grid matches it.
   */
  assert.equal(
    trackCount(byMedia.get(null).value),
    TOOL_COUNT,
    `widest window: one column per tool (${TOOL_COUNT})`,
  );
  assert.equal(
    trackCount(byMedia.get('@media (max-width: 1400px)').value),
    3,
    'below 1400px: three across',
  );
  assert.equal(
    trackCount(byMedia.get('@media (max-width: 1100px)').value),
    2,
    'below 1100px: two across',
  );
  assert.equal(
    trackCount(byMedia.get('@media (max-width: 700px)').value),
    1,
    'below 700px: one across',
  );
});

test('no grid track is wider than the narrowest supported viewport', () => {
  // The regression this guards: `.app-grid`'s single-column tier was
  // `minmax(0, 330px)`, which reads like it can shrink but still needs 330px
  // plus the .app-menu padding -- 362px, against a 320px floor.
  const offenders = [];
  for (const selector of [
    '.app-grid',
    '.image-grid',
    '.pdf-app',
    '.image-app',
    '.map-app',
  ]) {
    for (const rule of columnsOf(selector)) {
      if (!rule.value) continue;
      const widest = widestTrack(rule.value);
      if (widest !== null && widest > MIN_VIEWPORT) {
        offenders.push(
          `${selector} in ${rule.media ?? 'the base rule'}: ${rule.value}`,
        );
      }
    }
  }
  assert.deepEqual(offenders, [], 'a fixed track wider than the 320px floor');
});

test('the menu grid never needs more width than its own content box', () => {
  /*
   * The regression: the single-column tier was `minmax(0, 330px)`, which reads
   * like it can shrink. It cannot -- a track's max is a request, not a bound --
   * so the grid still needed 330px plus `.app-menu`'s 16px of padding on each
   * side: 362px against a 320px floor, which scrolled the menu sideways.
   *
   * The fix is structural, so the assertion is structural too: no tier may size
   * a track in pixels, which makes the grid's own width `min(container, cap)` in
   * every case and the arithmetic above unrepresentable.
   */
  for (const rule of columnsOf('.app-grid')) {
    if (!rule.value) continue;
    assert.doesNotMatch(
      rule.value,
      /\d+px/,
      `${rule.media ?? 'the base rule'} sizes a track in pixels: ${rule.value}`,
    );
  }

  // And the cap must be a maximum, not a floor. `width: 330px` or
  // `min-width: 330px` would reintroduce the overflow the fluid track removed.
  for (const rule of blocksFor('.app-grid')) {
    assert.doesNotMatch(
      rule.body,
      /(^|[^-])width:\s*\d+px/,
      `${rule.media ?? 'the base rule'} sets a fixed width instead of a cap`,
    );
    /*
     * The cap has to leave each card a readable width, and has to be derived
     * rather than asserted against a literal.
     *
     * It used to be checked as `<= 1400px`, a number that was true only while
     * the cap was the five-card 1322px. With six tools the cap is 1590px, which
     * is exactly 6 x 250px + 5 x 18px: the cards keep the width they always had,
     * and the cap grew with them. So the invariant is the per-card width the cap
     * implies, which stays true whatever the card count becomes.
     */
    const cap = rule.body.match(/max-width:\s*(\d+)px/);
    const columns = rule.body.match(/grid-template-columns:\s*repeat\((\d+),/);
    /* Only the widest tier: the narrower ones hold fewer, larger cards on
       purpose, and a card that is 339px wide in a two-column tier is the design,
       not a regression. */
    if (cap && columns && rule.media === null) {
      const gap = Number((rule.body.match(/gap:\s*(\d+)px/) ?? [])[1] ?? 0);
      const perCard =
        (Number(cap[1]) - (Number(columns[1]) - 1) * gap) / Number(columns[1]);
      assert.ok(
        perCard >= 220 && perCard <= 320,
        `${rule.media ?? 'the base rule'} caps the grid at ${cap[1]}px, which leaves each of ${columns[1]} cards ${Math.round(perCard)}px - outside the 220-320px a card should occupy`,
      );
    }
  }

  const base = blocksFor('.app-grid').find(({ media }) => media === null);
  assert.match(base.body, /max-width:\s*\d+px/, 'the grid states its own cap');
  assert.match(
    base.body,
    /margin-inline:\s*auto/,
    'the capped grid stays centred',
  );
});

test('full-height panes are sized against the visible viewport, not 100vh', () => {
  // `100vh` is the largest viewport: on a phone it is 60-100px taller than what
  // is visible once a URL bar is showing, which clips a pane's status bar.
  assert.match(
    css,
    /--viewport-h:\s*100vh;/,
    'the token falls back to 100vh for a browser without dvh',
  );
  assert.match(
    css,
    /@supports \(height: 100dvh\)[\s\S]*?--viewport-h:\s*100dvh;/,
    'the token prefers dvh where it is supported',
  );

  // The only 100vh left is the token's own fallback declaration. Comments are
  // stripped, so any other occurrence is a real rule that regressed.
  const strays = RULES.filter(
    (rule) =>
      rule.body.includes('100vh') &&
      // the fallback itself: a :root whose only use of 100vh is the token
      !(
        rule.selector === ':root' &&
        /--viewport-h:\s*100vh;/.test(rule.body) &&
        !rule.body.replace(/--viewport-h:\s*100vh;/, '').includes('100vh')
      ),
  ).map((rule) => `${rule.selector} { ${rule.body.trim()} }`);
  assert.deepEqual(
    strays,
    [],
    'a pane is sized against 100vh instead of the token',
  );

  const uses = RULES.filter((rule) => rule.body.includes('var(--viewport-h)'));
  assert.ok(
    uses.length >= 12,
    `the token is actually used by the panes, not just declared (${uses.length})`,
  );
  for (const selector of [
    '.editor-app',
    '.app-menu',
    '.toc-manager',
    '.pdf-app',
    '.image-app',
    '.map-app',
  ]) {
    const rule = blocksFor(selector).find(({ media }) => media === null);
    assert.match(
      rule.body,
      /var\(--viewport-h\)/,
      `${selector} is a full-height pane and reads the token`,
    );
  }
});

test('the status bar is a bottom strip that leads with the toggle', () => {
  /*
   * The bar was a 72px top header with a brand mark, a subtitle, a report pill
   * and the "All apps" button -- three static strings and a 25px tile for
   * permanent vertical space. It is now 30px along the bottom: toggle first, then
   * the title on one line, and the report only when there is something to say.
   */
  const component = readFileSync(
    new URL('../src/App.vue', import.meta.url),
    'utf8',
  );
  const bar = blocksFor('.launcher-header').find(
    ({ media, body }) => media === null && /padding/.test(body),
  );
  assert.match(bar.body, /min-height:\s*var\(--statusbar-h\)/);
  // At the bottom: a top border, not a bottom one, and it is ordered last.
  assert.match(
    bar.body,
    /border-top:\s*1px solid/,
    'the bar sits below the panes',
  );
  assert.doesNotMatch(
    bar.body,
    /border-bottom/,
    'the bar no longer caps the panes',
  );
  const order = blocksFor('.launcher-header').find(
    ({ media, body }) => media === null && /order/.test(body),
  );
  assert.match(
    order.body,
    /order:\s*1/,
    'the first child in the DOM is drawn last',
  );

  // The toggle leads, so it is the first control in the bar, and the title is a
  // single truncated line after it.
  const toggle = component.indexOf('id="back-to-menu"');
  const title = component.indexOf('class="app-title"');
  assert.ok(toggle > 0 && title > toggle, 'the toggle precedes the title');
  assert.match(blocksFor('.app-title')[0].body, /white-space:\s*nowrap/);
  assert.match(blocksFor('.app-title')[0].body, /text-overflow:\s*ellipsis/);

  // The brand block is gone from the markup, not just restyled: it was static
  // and said nothing the title does not.
  assert.doesNotMatch(component, /class="brand-mark"/);
  assert.doesNotMatch(component, /class="brand-subtitle"/);
  assert.doesNotMatch(css, /^\.brand-mark \{/m);
});

test('both bars pad themselves by the device insets they actually face', () => {
  /*
   * The two bars are no longer symmetrical. `.topbar` is the editor's top bar
   * and pads top *and* bottom. `.launcher-header` became a 30px status bar along
   * the bottom, so it faces the home indicator and nothing else: it takes the
   * bottom inset and no top inset. Asserting the old symmetry here is what
   * caught the move, which is the point.
   */
  assert.match(
    css,
    /--topbar-safe-top:\s*env\(safe-area-inset-top,\s*0px\)/,
    'the top inset is read from the device',
  );
  assert.match(
    css,
    /--topbar-safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
    'the home-indicator inset is read from the device',
  );
  assert.match(
    css,
    /--statusbar-safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
    'the status bar reads the home-indicator inset',
  );

  const top = blocksFor('.topbar').find(({ media }) => media === null);
  assert.match(top.body, /padding:[^;]*var\(--topbar-safe-top\)/);
  assert.match(top.body, /var\(--topbar-safe-bottom\)/);

  const bar = blocksFor('.launcher-header').find(
    ({ media, body }) => media === null && /padding/.test(body),
  );
  assert.ok(bar, 'the status bar declares its padding');
  assert.match(
    bar.body,
    /var\(--statusbar-safe-bottom\)/,
    'the status bar pads its bottom by the inset',
  );
  assert.doesNotMatch(
    bar.body,
    /--topbar-safe-top/,
    'the status bar must not take the top inset; it is at the bottom',
  );
});

test('every full-height pane subtracts the status bar token, not a literal', () => {
  /*
   * The bar's height was 72px, spelled as a literal in six rules, which is
   * exactly the pair that drifts. It is now --statusbar-h, and no pane may go
   * back to a literal: a literal 30px here and a token there would be an
   * off-by-a-token bug that no screenshot would catch.
   */
  const panes = [
    '.editor-app',
    '.app-menu',
    '.toc-manager',
    '.pdf-app',
    '.image-app',
    '.map-app',
  ];
  for (const selector of panes) {
    // `.editor-app` and `.launcher-header` are each named by two base rules, so
    // the one that sizes itself against the viewport is selected explicitly.
    // `[^;]*` rather than `.*` because these blocks contain multi-line comments
    // with a `calc()` in them, which a dot would run straight past.
    const rule = blocksFor(selector).find(
      ({ media, body }) =>
        media === null && /height:[^;]*--statusbar-h/.test(body),
    );
    assert.ok(rule, `${selector} is a full-height pane`);
    assert.match(
      rule.body,
      /calc\(var\(--viewport-h\) - var\(--statusbar-h\)\)/,
      `${selector} does not size itself against --statusbar-h`,
    );
    assert.doesNotMatch(
      rule.body,
      /calc\(var\(--viewport-h\) - \d+px\)/,
      `${selector} subtracts a literal height instead of the bar token`,
    );
  }

  // And the token is defined once, with the inset added on top of the content
  // rather than taken out of it.
  assert.match(
    css,
    /--statusbar-h:\s*calc\(30px \+ var\(--statusbar-safe-bottom\)\)/,
  );
  /*
   * A finger needs 44px and the report's dismiss control is a tap target in this
   * bar, so the token grows under a coarse pointer. If it did not, the bar would
   * clip the button and every pane would overflow the viewport by 14px.
   */
  assert.match(
    css,
    /@media \(pointer: coarse\)[\s\S]*?--statusbar-h:\s*calc\(44px \+ var\(--statusbar-safe-bottom\)\)/,
  );
});

test('the editor grid row and the top bar share one height', () => {
  /*
   * The topbar adds the insets to its 56px of content, so the .editor-app row
   * that holds it has to grow by the same amount or the bar overflows its track.
   * `.editor-app` is named by two base rules -- a shared min-height list and its
   * own grid -- so the one carrying the row template is selected, not the first.
   */
  const app = blocksFor('.editor-app').find(
    ({ media, body }) => media === null && /grid-template-rows/.test(body),
  );
  assert.ok(app, '.editor-app declares its grid rows');
  assert.match(app.body, /grid-template-rows:\s*var\(--topbar-h\)/);
  const bar = blocksFor('.topbar').find(({ media }) => media === null);
  assert.match(bar.body, /height:\s*var\(--topbar-h\)/);
  assert.match(
    css,
    /--topbar-h:\s*calc\(56px \+ var\(--topbar-safe-top\) \+ var\(--topbar-safe-bottom\)\)/,
    'the shared height adds both insets to the 56px of content',
  );
});

test('the whole menu fits a phone viewport without scrolling', () => {
  /*
   * At the desktop density the five cards alone were 632px -- 5 x 112px plus four
   * 18px gaps -- which with the heading and padding is about 866px, so an
   * iPhone SE (667px, less a 72px header = 595px of menu) had to scroll to
   * reach the fifth tool.
   *
   * These are the sheet's own numbers rather than a rendering, so the test
   * asserts the arithmetic the CSS has to keep true: five cards at the phone
   * card's min-height, plus the gaps, plus the heading and padding, must fit.
   */
  const SE_VIEWPORT = 667;
  const HEADER = 72; // .launcher-header's min-height
  const budget = SE_VIEWPORT - HEADER;

  const phone = (selector) =>
    blocksFor(selector).find(({ media }) =>
      media?.includes('max-width: 480px'),
    );
  const px = (rule, property) =>
    Number(rule.body.match(new RegExp(`${property}:\\s*([\\d.]+)px`))?.[1]);

  // The density tier has to exist, or this test silently measures the desktop
  // card and passes for the wrong reason.
  const card = phone('.app-card');
  assert.ok(card, 'there is a phone-density tier for .app-card');
  assert.ok(
    px(card, 'min-height') < 100,
    `the phone card is still ${px(card, 'min-height')}px tall`,
  );

  // The card's icon track has to shrink with it: at a 44px icon and 12px gaps a
  // 288px phone column still leaves room for an unclipped 1rem title.
  const tracks = card.body.match(/grid-template-columns:\s*([^;]+)/)[1];
  assert.match(
    tracks,
    /^44px minmax\(0, 1fr\) auto$/,
    `the phone card tracks are ${tracks}`,
  );
  assert.equal(
    px(phone('.app-icon'), 'width'),
    44,
    'the icon shrinks to match its track',
  );

  const stack = 5 * px(card, 'min-height') + 4 * px(phone('.app-grid'), 'gap');
  /*
   * `padding: 24px 16px 32px` and `margin: 8px 0 6px` each have three terms and
   * two capture groups, so the match is [full, top, bottom]: skipping index 0
   * and reading the two groups is clearer than slicing, and the middle term (a
   * side padding, a bare 0) is deliberately not captured.
   */
  const [, top, bottom] = phone('.app-menu')
    .body.match(/padding:\s*([\d.]+)px [\d.]+px ([\d.]+)px/)
    .map(Number);

  /*
   * The heading is measured from its own rules rather than estimated: the
   * eyebrow at 0.7rem, the h1 at its `clamp(1.7rem, 4vw, 2.6rem)` floor, the
   * paragraph at 0.92rem, and the margins the phone tier sets. 4vw of a 320px
   * phone is 12.8px, so the clamp's lower bound is what actually renders.
   */
  const line = (rem) => rem * 16 * 1.2;
  const h1 = phone('.menu-heading h1');
  // `margin: 8px 0 6px` -- the middle term is a bare 0, not `0px`, and is not captured.
  const [, h1Top, h1Bottom] = h1.body
    .match(/margin:\s*([\d.]+)px [\d.]+(?:px)? ([\d.]+)px/)
    .map(Number);
  const heading =
    line(0.7) + // the eyebrow
    h1Top +
    line(1.7) + // the h1's clamp floor
    h1Bottom +
    line(0.92) + // the paragraph
    px(phone('.menu-heading'), 'margin-bottom');

  assert.ok(
    stack + heading + top + bottom <= budget,
    `the menu is ${stack + heading + top + bottom}px against a ${budget}px budget (5 cards, heading, padding)`,
  );

  // And the badge must still be clamped: the card is a fixed height, so an
  // unclamped third line would push the arrow out of it. The desktop rules
  // `tests/static-shell.test.js` locks are inherited, not restated.
  const copy = phone('.app-card-copy small');
  assert.ok(copy, 'the phone tier tunes the badge');
  assert.ok(
    Number(copy.body.match(/font-size:\s*([\d.]+)rem/)[1]) <= 0.76,
    'the phone badge grew rather than shrank',
  );
});

test('every touch target reaches 44px, and only on a coarse pointer', () => {
  /*
   * 44px is the smallest reliably tappable target (iOS HIG; Android's a11y
   * guidance asks 48dp). The audit found the sheet almost nowhere near it:
   * .toolbar-button computed to 30.8px, the outline row's square buttons to
   * 28px, and the 700px tier *shrank* .toolbar-button to 29.6px on exactly the
   * devices that need it larger.
   *
   * Keyed on the pointer, not the width, so a narrow desktop window keeps the
   * dense layout and a tablet at any width gets the roomier one.
   */
  const TOUCH_TARGET = 44;
  const coarse = RULES.filter(
    (rule) => rule.media === '@media (pointer: coarse)',
  );
  assert.ok(coarse.length > 0, 'there is a coarse-pointer block');

  /** Every selector the block promises a 44px floor to. */
  const raised = coarse.flatMap((rule) =>
    rule.selector
      .split(',')
      .map((selector) => selector.trim())
      .filter(Boolean),
  );
  const floored = new Map();
  for (const rule of coarse) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      if (!selector) continue;
      const min = Math.max(
        Number(rule.body.match(/min-height:\s*(\d+)px/)?.[1] ?? 0),
        Number(rule.body.match(/min-width:\s*(\d+)px/)?.[1] ?? 0),
        Number(rule.body.match(/(?:^|;)\s*height:\s*(\d+)px/)?.[1] ?? 0),
        Number(rule.body.match(/(?:^|;)\s*width:\s*(\d+)px/)?.[1] ?? 0),
      );
      if (min) floored.set(selector, Math.max(floored.get(selector) ?? 0, min));
    }
  }

  /*
   * The controls a finger actually has to hit. Each is in the coarse block with
   * a 44px floor; the assertion is on the pair, so dropping a control from the
   * block fails even though it is still listed in `raised`.
   */
  const required = [
    '.toolbar-button',
    '.toc-pick-item',
    '.recent-path',
    '.image-group-button',
    '.toc-outline-remove',
    '.toc-outline-move',
    '.toc-outline-edit',
    '.workspace-report-dismiss',
    '.map-place-action',
    '.toc-outline-link',
    '.toc-item',
  ];
  for (const selector of required) {
    assert.ok(
      raised.includes(selector),
      `${selector} is a touch target but is not in the coarse-pointer block`,
    );
    assert.ok(
      (floored.get(selector) ?? 0) >= TOUCH_TARGET,
      `${selector} gets ${floored.get(selector) ?? 0}px, below ${TOUCH_TARGET}px`,
    );
  }

  // The lightbox arrows are sized in both axes, and the narrow-window tier
  // shrinks them to 38px -- so the coarse floor has to come after it.
  const lightbox = floored.get('.lightbox-close');
  assert.ok(lightbox >= TOUCH_TARGET, `the lightbox arrows are ${lightbox}px`);

  /*
   * The 700px tier sets 0.72rem against a base of 0.78rem, which is why a
   * 30.8px button became 29.6px on exactly the devices that most need it bigger.
   * That cut is pre-existing and is what the coarse block's min-height exists to
   * absorb, and min-height beats a font-derived height no matter how small the
   * type gets. What would defeat the floor is a later rule setting a *smaller*
   * min-height, so that is what is asserted: the narrow tier may shrink the type
   * but may not lower the floor.
   */
  const narrow = blocksFor('.toolbar-button').find(({ media }) =>
    media?.includes('max-width: 700px'),
  );
  assert.ok(narrow, 'the 700px tier still has a .toolbar-button rule');
  const narrowFloor = narrow.body.match(/min-height:\s*(\d+)px/);
  assert.ok(
    !narrowFloor || Number(narrowFloor[1]) >= TOUCH_TARGET,
    `the narrow tier lowers the touch floor to ${narrowFloor?.[1]}px`,
  );
  assert.doesNotMatch(
    narrow.body,
    /(^|;)\s*height:\s*\d+px/,
    'the narrow tier fixes a height that min-height cannot lift',
  );

  // And the pointer-fine layout is untouched: a control's own padding is left
  // alone, so a mouse-sized pointer still sees the sheet's spacing and a coarse
  // one only gains a floor. (The block does pad the *containers* --
  // .toc-outline-item, .map-place-row, .image-thumbnail -- which is what gives
  // the newly-tall button somewhere to sit without crowding its neighbours.)
  for (const rule of coarse) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      if (!required.includes(selector)) continue;
      assert.doesNotMatch(
        rule.body,
        /(^|;)\s*padding:\s*[^;]*;/,
        `${selector} changes its own padding under a coarse pointer, which reflows the toolbar`,
      );
    }
  }
});

test('form fields reach 16px on a coarse pointer', () => {
  // Below 16px, iOS Safari zooms the viewport when the field is focused and does
  // not zoom back out, so a form becomes unusable on a phone. The shared rule
  // sets 0.85rem; the coarse block has to lift it for every one of its selectors.
  const rule = RULES.find(
    (r) =>
      r.media === '@media (pointer: coarse)' &&
      r.selector.includes('.toc-edit input'),
  );
  assert.ok(
    rule,
    'the shared form-field rule has a coarse-pointer counterpart',
  );
  assert.match(rule.body, /font-size:\s*1rem/);
  for (const selector of [
    '.toc-declare-bar input',
    '.toc-filter input',
    '.toc-edit select',
    '.toc-link-panel select',
    '.lightbox-attach select',
    '.map-options select',
  ]) {
    assert.ok(
      rule.selector.includes(selector),
      `${selector} is a form field left below the iOS zoom threshold`,
    );
  }
});

test('hover styling is guarded, and never at the cost of the focus ring', () => {
  /*
   * A touch device keeps `:hover` latched on the last-tapped element until
   * something else is tapped. Unguarded, the menu card the user just chose stayed
   * raised with a blue border, reading as "selected" long after they moved on --
   * and every one of the ~20 hover rules here had that problem.
   */
  const guarded = RULES.filter(
    (rule) => rule.media === '@media (hover: hover)',
  );
  assert.ok(
    guarded.length >= 15,
    `only ${guarded.length} hover rules are guarded`,
  );

  const strays = RULES.filter(
    (rule) =>
      rule.media !== '@media (hover: hover)' &&
      rule.selector.includes(':hover'),
  ).map((rule) => `${rule.media ?? 'base'}: ${rule.selector}`);
  assert.deepEqual(
    strays,
    [],
    'a :hover rule applies on a device that cannot hover',
  );

  /*
   * Guarding is only safe if the affordance survives for a keyboard. Each hover
   * target must still have a `:focus-visible` or `.active` rule of its own -- and
   * a base-class rule counts, because `.toolbar-button.subtle:hover` is reachable
   * by the shared `.toolbar-button:focus-visible` outline.
   */
  const hoverTargets = new Set();
  for (const rule of guarded) {
    for (const part of rule.selector.split(',')) {
      const target = part.trim();
      if (target.includes(':hover'))
        hoverTargets.add(target.replace(/:hover.*$/, ''));
    }
  }
  assert.ok(
    hoverTargets.size >= 15,
    `only ${hoverTargets.size} distinct hover targets`,
  );

  const nonHoverAffordance = new Set();
  for (const rule of RULES) {
    if (rule.media === '@media (hover: hover)') continue;
    for (const part of rule.selector.split(',')) {
      const target = part.trim();
      if (target.includes(':focus-visible')) {
        nonHoverAffordance.add(target.replace(/:focus-visible.*$/, ''));
      } else if (target.includes('.active')) {
        nonHoverAffordance.add(target.replace(/\.active.*$/, ''));
      }
    }
  }

  const orphans = [...hoverTargets]
    .filter((target) => {
      if (nonHoverAffordance.has(target)) return false;
      // fall back to the base class: `.toolbar-button.subtle` -> `.toolbar-button`
      const base = target.split('.').slice(0, 2).join('.');
      return !nonHoverAffordance.has(base);
    })
    .sort();
  assert.deepEqual(
    orphans,
    [],
    'a hover affordance with no focus-visible or .active equivalent',
  );
});

test('all three sidebars overlay on a phone and stay mounted when closed', () => {
  /*
   * The map already promoted its sidebar to an overlay at 900px; the reader and
   * the viewer only narrowed their columns, which left a 360px phone a 195px
   * page canvas and a 145px folder list. They now use the map's pattern.
   */
  const narrow = (selector) =>
    blocksFor(selector).filter(({ media }) =>
      media?.includes('max-width: 700px'),
    );

  for (const shell of ['.pdf-app', '.image-app']) {
    const tier = narrow(shell).find((rule) =>
      /grid-template-columns/.test(rule.body),
    );
    assert.ok(tier, `${shell} has a narrow tier`);
    assert.match(
      tier.body,
      /grid-template-columns:\s*minmax\(0, 1fr\);/,
      `${shell} keeps a sidebar column on a phone instead of overlaying it`,
    );
  }

  // The overlay itself: both panels leave the grid and cover the content.
  for (const panel of ['.toc-sidebar', '.image-sidebar']) {
    const rule = narrow(panel)[0];
    assert.ok(rule, `${panel} has a narrow tier`);
    assert.match(
      rule.body,
      /position:\s*absolute/,
      `${panel} does not overlay`,
    );
    assert.match(rule.body, /z-index:\s*4/);
    // min() rather than a fixed 280px: on a 320px phone a 280px panel leaves
    // 40px of backdrop, which is too little to tap to dismiss.
    assert.match(
      rule.body,
      /width:\s*min\(\d+px, \d+vw\)/,
      `${panel} is a fixed width`,
    );
  }

  // Closing narrows the column rather than unmounting the pane, which is what
  // keeps the panel's scroll position and the page renderer's measured width.
  for (const shell of ['.pdf-app', '.image-app']) {
    assert.ok(
      blocksFor(`${shell}.sidebar-closed`).length > 0,
      `${shell} has no sidebar-closed column rule`,
    );
  }
  for (const panel of ['.toc-sidebar.closed', '.image-sidebar.closed']) {
    const rule = blocksFor(panel)[0];
    assert.ok(rule, `${panel} has no closed state`);
    assert.match(
      rule.body,
      /(visibility:\s*hidden|display:\s*none)/,
      `${panel} stays laid out when closed`,
    );
  }

  // The backdrop is inert on a desktop, so it can never eat a click on the page.
  const backdrop = blocksFor('.sidebar-backdrop')[0];
  assert.ok(backdrop, 'the backdrop is not display:none by default');
  assert.match(backdrop.body, /display:\s*none/);
  assert.ok(
    narrow('.sidebar-backdrop').some((rule) =>
      /display:\s*block/.test(rule.body),
    ),
    'the backdrop never appears on a desktop',
  );
});
