/*
 * Two independent app states in one test process.
 *
 * Every session used to be a module of exported refs, so a test could only ever
 * see the single app instance and had to reset whatever it touched. These
 * tests build two of each session side by side and assert that their state,
 * their collaborators, and their side effects stay separate — which is what
 * makes a real component test (TODO-017) possible.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAppShell } from '../src/app-shell.js';
import { createEditorSession } from '../src/editor-session.js';
import { createImageSession } from '../src/image-session.js';
import { createPdfSession } from '../src/pdf-session.js';
import { createTocOutline } from '../src/toc-outline.js';

const boot = {
  view: 'menu',
  tocItems: [],
  activeTocId: null,
  editor: { content: '' },
  pdf: { name: '', size: 0, url: '', documentId: '', page: 1, zoom: 1 },
  images: { directoryName: '', selectedGroup: 'All Images' },
};

/* A document stub good enough for the focus/element lookups the sessions do. */
function fakeDocument() {
  const focused = [];
  const elements = new Map();
  return {
    focused,
    createElement: () => ({ style: {}, focus() {} }),
    getElementById: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          focus() {
            focused.push(id);
          },
        });
      }
      return elements.get(id);
    },
    querySelector: () => null,
  };
}

describe('independent editor sessions', () => {
  test('two editors keep separate buffers and notices', () => {
    const first = createEditorSession({ boot });
    const second = createEditorSession({ boot });

    first.editorContent.value = 'first draft';
    second.setEditorNotice('second failed', true);

    assert.equal(first.editorContent.value, 'first draft');
    assert.equal(second.editorContent.value, '');
    assert.equal(first.editorNotice.value, '');
    assert.equal(second.editorNoticeError.value, true);
    assert.equal(first.editorWordCount.value, 2);
    assert.equal(second.editorWordCount.value, 0);
  });

  test('the cursor readout is per session', () => {
    const session = createEditorSession({ boot });
    session.editorInput.value = {
      value: 'one\ntwo',
      selectionStart: 7,
    };
    session.updateCursor();
    assert.equal(session.cursorPosition.value, 'Line 2, Col 4');
  });
});

describe('independent app shells', () => {
  test('two shells route and record interaction separately', () => {
    const first = createAppShell({ boot, afterNextTick: (fn) => fn() });
    const second = createAppShell({ boot, afterNextTick: (fn) => fn() });

    const events = [];
    first.onViewLeaveEditor(() => events.push('first-left-editor'));
    second.onViewLeaveEditor(() => events.push('second-left-editor'));

    first.selectView('editor');
    assert.equal(first.hasUserInteracted(), true);
    assert.equal(second.hasUserInteracted(), false);

    first.selectView('menu');
    assert.deepEqual(events, ['first-left-editor']);
    assert.equal(second.view.value, boot.view);
  });

  test('the focus stub is the injected one, not a real textarea', () => {
    const focused = [];
    const shell = createAppShell({
      boot,
      editorRef: { value: { focus: () => focused.push('editor') } },
      afterNextTick: (fn) => fn(),
    });
    shell.selectView('editor');
    assert.deepEqual(focused, ['editor']);
  });
});

describe('independent image sessions', () => {
  test('collections and status do not leak between sessions', () => {
    const first = createImageSession({ boot, native: () => null });
    const second = createImageSession({ boot, native: () => null });

    first.setImageCollection(
      [
        {
          name: 'a.png',
          relativePath: 'a.png',
          group: 'All Images',
          dataUrl: 'data:image/png;base64,x',
        },
      ],
      'first folder',
    );
    second.setImageStatus('nothing here', true);

    assert.equal(first.imageFiles.value.length, 1);
    assert.equal(second.imageFiles.value.length, 0);
    assert.equal(first.imageDirectoryName.value, 'first folder');
    assert.equal(second.imageStatusError.value, true);
    assert.match(first.imagesBadge.value, /first folder/);
  });
});

describe('independent PDF sessions', () => {
  test('session state is per instance', () => {
    const native = () => null;
    const first = createPdfSession({ boot, native, call: (fn) => fn() });
    const second = createPdfSession({ boot, native, call: (fn) => fn() });

    first.pdfPageNumber.value = 12;
    first.setPdfStatus('loading', true);
    second.pdfPageNumber.value = 3;

    assert.equal(first.pdfPageNumber.value, 12);
    assert.equal(second.pdfPageNumber.value, 3);
    assert.equal(first.pdfStatusError.value, true);
    assert.equal(second.pdfStatusError.value, false);
    assert.equal(
      second.pdfStatus.value,
      'Choose a PDF from your system to begin reading.',
    );
  });
});

describe('independent outlines with stub collaborators', () => {
  /* Minimal stand-ins for the four sessions an outline binds to. */
  function collaborators() {
    const notice = [];
    const imageStatus = [];
    const mapFlown = [];
    const mapShown = [];
    const mapStatus = [];
    const pdfStatus = [];
    return {
      notice,
      imageStatus,
      mapFlown,
      mapShown,
      mapStatus,
      pdfStatus,
      editor: {
        editorContent: { value: '' },
        editorInput: { value: null },
        setEditorNotice: (message) => notice.push(message),
        clearEditorNotice: () => notice.push(''),
        updateCursor: () => {},
      },
      shell: {
        markUserInteracted: () => {},
        selectView: () => {},
      },
      pdf: {
        pdfDocument: { value: null },
        pdfName: { value: '' },
        pdfPageNumber: { value: 1 },
        pdfPath: { value: '' },
        pdfStatus: { value: '' },
        pdfStatusError: { value: false },
        setPdfStatus: (message) => pdfStatus.push(message),
        navigateToPage: () => {},
        openPdfAt: () => {},
        tocHeadings: { value: [] },
        setTocMessage: () => {},
      },
      images: {
        activeLightboxImage: { value: null },
        imageFiles: { value: [] },
        selectedImageGroup: { value: 'All Images' },
        imageGroupFromRelativePath: (path) => path,
        setImageCollection: () => {},
        openLightbox: () => {},
        setImageStatus: (message) => imageStatus.push(message),
      },
      map: {
        mapPin: { value: null },
        showMapLocation: (value) => {
          mapShown.push(value);
          return true;
        },
        flyToLocation: (value) => {
          mapFlown.push(value);
          return true;
        },
        setMapStatus: (message) => mapStatus.push(message),
      },
      transfer: {
        read: async () => ({ canceled: true }),
        write: async () => ({ canceled: true }),
      },
    };
  }

  function stubOutline() {
    const doc = fakeDocument();
    const deps = collaborators();
    const outline = createTocOutline({
      boot: { ...boot, tocItems: [] },
      doc,
      defer: (fn) => fn(),
      editor: deps.editor,
      shell: deps.shell,
      pdf: deps.pdf,
      images: deps.images,
      map: deps.map,
      transfer: deps.transfer,
    });
    return { outline, doc, deps };
  }

  test('two outlines declare, edit, and reorder independently', () => {
    const first = stubOutline();
    const second = stubOutline();

    first.outline.tocDraftTitle.value = 'First';
    first.outline.addTocItem();
    second.outline.tocDraftTitle.value = 'Second';
    second.outline.addTocItem();

    assert.equal(first.outline.tocItems.value.length, 1);
    assert.equal(second.outline.tocItems.value.length, 1);
    assert.equal(first.outline.tocItems.value[0].title, 'First');
    assert.equal(second.outline.tocItems.value[0].title, 'Second');

    // Reordering in one outline cannot touch the other.
    second.outline.tocDraftTitle.value = 'Third';
    second.outline.addTocItem();
    first.outline.moveTocItem(first.outline.tocItems.value[0], -1);
    assert.equal(first.outline.tocItems.value[0].title, 'First');
    assert.equal(second.outline.tocItems.value.length, 2);

    // Removal and undo are per instance.
    second.outline.removeTocItem(second.outline.tocItems.value[0]);
    assert.equal(second.outline.tocItems.value.length, 1);
    assert.equal(first.outline.tocItems.value.length, 1);
    second.outline.undoTocRemoval();
    assert.equal(second.outline.tocItems.value.length, 2);
  });

  test('the injected document receives the focus calls', () => {
    const { outline, doc } = stubOutline();
    outline.tocDraftTitle.value = 'Focusable';
    outline.addTocItem();
    assert.ok(doc.focused.includes('toc-title-input'));
  });

  test('status goes to the outline, not to the collaborators', () => {
    const { outline, deps } = stubOutline();
    outline.tocDraftTitle.value = 'Persisted';
    outline.addTocItem();
    assert.match(outline.tocStatus.value, /declared/);
    // The editor stub is a different channel and must stay untouched.
    assert.deepEqual(deps.notice, []);
  });

  test('a failing write is reported through the injected persist hook', () => {
    const doc = fakeDocument();
    const deps = collaborators();
    const outline = createTocOutline({
      boot: { ...boot, tocItems: [] },
      doc,
      defer: (fn) => fn(),
      editor: deps.editor,
      shell: deps.shell,
      pdf: deps.pdf,
      images: deps.images,
      map: deps.map,
      transfer: deps.transfer,
      persist: () => false,
    });
    outline.tocDraftTitle.value = 'Unsaved';
    outline.addTocItem();
    assert.equal(outline.tocStatusError.value, true);
    assert.match(outline.tocStatus.value, /could not be saved/);
  });

  test('the export envelope is per instance', () => {
    const first = stubOutline();
    const second = stubOutline();
    first.outline.tocDraftTitle.value = 'Only here';
    first.outline.addTocItem();

    const envelope = JSON.parse(first.outline.exportTocJson());
    assert.equal(envelope.format, 'metrics-toc');
    assert.equal(envelope.items.length, 1);
    assert.equal(JSON.parse(second.outline.exportTocJson()).items.length, 0);
  });

  test('the image-link cap is enforced through the injected session', () => {
    const { outline, deps } = stubOutline();
    outline.tocDraftTitle.value = 'Illustrated';
    outline.addTocItem();
    outline.selectTocItem(outline.tocItems.value[0]);
    for (let index = 0; index < 70; index++) {
      outline.attachImageToToc({
        name: `s${index}.png`,
        relativePath: `s${index}.png`,
      });
    }
    assert.equal(outline.tocItems.value[0].links.images.length, 64);
    assert.match(deps.imageStatus.at(-1), /already links 64 images/);
  });
});
