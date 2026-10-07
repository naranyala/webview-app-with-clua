/*
 * The outline test harness, shared by the three toc-outline test files.
 *
 * This was the preamble of one 1100-line file. Splitting the file along the
 * boundaries the module already had meant three copies of ~90 lines of global
 * setup, and the copies would not be equal: the `document` and `window` stubs and
 * the persistence counter are per-module state, so a test asserting on a persist
 * count in one file could not see it in another, and a reader would have no way to
 * tell which copy was the real one.
 *
 * So the harness is here and imported once per file. The counters and the
 * outcome are accessors rather than exported bindings because a module's exported
 * `let` is live but unassignable from outside - the tests need to reset them
 * between cases, so a function is the only shape that works.
 */
import { editorContent } from '../../src/editor-session.js';
import { closeLightbox } from '../../src/image-session.js';
import {
  activeTocId,
  cancelTocEdit,
  configureTocOutline,
  lastRemoved,
  linkTargetId,
  setTocStatus,
  tocDraftLevel,
  tocDraftTitle,
  tocFilterQuery,
  tocItems,
} from '../../src/toc-outline.js';
import { createTocItem } from '../../src/workspace.js';

/* The outline focuses template elements on nextTick; Node has no document. */
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
};

/* Native transfer bindings are opt-in per test; none exist by default. */
globalThis.window = {};

let saves = 0;
let persistResult = true;

configureTocOutline({
  persistNow: () => {
    saves += 1;
    return persistResult;
  },
});

/** How many times the outline has asked to be saved since the last reset. */
export function persistCount() {
  return saves;
}

/**
 * Makes the next persist succeed or fail.
 *
 * A test that wants "the save failed" needs to say so; leaving the counter and the
 * outcome as globals meant a case that forgot to reset one leaked into the next,
 * which is a failure that only shows up in some orders.
 */
export function setPersistResult(value) {
  persistResult = Boolean(value);
}

/** Zeroes the counter, so a case can assert "exactly one save" rather than a delta. */
export function resetPersistCount() {
  saves = 0;
}

export function makeItem(overrides = {}) {
  return createTocItem({ title: 'Section', level: 1, ...overrides });
}

/**
 * Puts the outline back to a known state between cases.
 *
 * Everything the outline module holds - items, selection, the draft title and
 * level, the filter, the in-progress rename, the undo slot, and the draft itself -
 * is reset here rather than by each test, because a case that leaves one set is
 * indistinguishable from a real bug in the next one.
 */
export function resetOutline(items = [], activeId = null) {
  closeLightbox();
  tocItems.value = items;
  activeTocId.value = activeId;
  linkTargetId.value = activeId || items[0]?.id || null;
  tocDraftTitle.value = '';
  tocDraftLevel.value = 1;
  tocFilterQuery.value = '';
  cancelTocEdit();
  lastRemoved.value = null;
  editorContent.value = '';
  persistResult = true;
  setTocStatus('idle');
}
