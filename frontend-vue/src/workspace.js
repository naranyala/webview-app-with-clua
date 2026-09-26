export const WORKSPACE_KEY = 'native-workspace.workspace.v1';
export const LEGACY_TOC_KEY = 'native-workspace.toc-items.v1';
export const WORKSPACE_VERSION = 1;

const VIEWS = ['menu', 'editor', 'toc', 'pdf', 'images'];
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.5;
const MAX_IMAGES_PER_ITEM = 64;

let idSequence = 0;

function nextTocId() {
  idSequence += 1;
  return `toc-${Date.now().toString(36)}-${idSequence.toString(36)}`;
}

function asString(value, limit = 0) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return limit > 0 ? trimmed.slice(0, limit) : trimmed;
}

function asPage(value) {
  const page = Math.floor(Number(value));
  return Number.isFinite(page) && page > 0 ? page : null;
}

function asZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1.1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export function clampLevel(value) {
  return Math.min(3, Math.max(1, Number(value) || 1));
}

export function normalizeLinks(raw) {
  const links = raw && typeof raw === 'object' ? raw : {};
  const images = Array.isArray(links.images)
    ? links.images
        .filter((path) => typeof path === 'string' && path.trim() !== '')
        .slice(0, MAX_IMAGES_PER_ITEM)
    : [];
  return {
    pdfPage: asPage(links.pdfPage),
    pdfName: asString(links.pdfName, 200),
    images,
  };
}

export function normalizeTocItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = asString(raw.title, 120);
  if (!title) return null;
  return {
    id: asString(raw.id, 64) || nextTocId(),
    title,
    level: clampLevel(raw.level),
    content: typeof raw.content === 'string' ? raw.content : '',
    links: normalizeLinks(raw.links),
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

export function normalizeTocItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeTocItem).filter(Boolean);
}

export function createTocItem({
  title,
  level = 1,
  content = '',
  links = null,
  updatedAt = 0,
}) {
  const heading = asString(title, 120);
  if (!heading) return null;
  return {
    id: nextTocId(),
    title: heading,
    level: clampLevel(level),
    content: typeof content === 'string' ? content : '',
    links: normalizeLinks(links),
    updatedAt: Number(updatedAt) || Date.now(),
  };
}

export function outlineSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const written = list.filter(
    (item) => String(item?.content ?? '').trim() !== '',
  ).length;
  return { total: list.length, written };
}

function normalizePdfSession(raw) {
  const pdf = raw && typeof raw === 'object' ? raw : {};
  return {
    name: asString(pdf.name, 200),
    size: Math.max(0, Math.floor(Number(pdf.size) || 0)),
    url: asString(pdf.url, 4096),
    documentId: asString(pdf.documentId, 128),
    page: asPage(pdf.page) ?? 1,
    zoom: asZoom(pdf.zoom),
  };
}

function normalizeImageSession(raw) {
  const images = raw && typeof raw === 'object' ? raw : {};
  return {
    directoryName: asString(images.directoryName, 200),
    selectedGroup: asString(images.selectedGroup, 200) || 'All Images',
  };
}

export function normalizeWorkspace(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const editor =
    source.editor && typeof source.editor === 'object' ? source.editor : {};
  const activeTocId = asString(source.activeTocId, 64);
  return {
    version: WORKSPACE_VERSION,
    savedAt: Math.max(0, Math.floor(Number(source.savedAt) || 0)),
    view: VIEWS.includes(source.view) ? source.view : 'menu',
    tocItems: normalizeTocItems(source.tocItems),
    activeTocId: activeTocId || null,
    editor: {
      content: typeof editor.content === 'string' ? editor.content : '',
    },
    pdf: normalizePdfSession(source.pdf),
    images: normalizeImageSession(source.images),
  };
}

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch (error) {
    return null;
  }
}

function readJson(storage, key) {
  try {
    const stored = storage.getItem(key);
    if (typeof stored !== 'string' || stored === '')
      return { found: false, value: null };
    return { found: true, value: JSON.parse(stored) };
  } catch (error) {
    console.error(`Could not read ${key}:`, error);
    return { found: false, value: null };
  }
}

export function loadWorkspace(storage) {
  const store = resolveStorage(storage);
  if (!store) return normalizeWorkspace(null);
  const current = readJson(store, WORKSPACE_KEY);
  if (current.found) return normalizeWorkspace(current.value);
  const legacy = readJson(store, LEGACY_TOC_KEY);
  if (legacy.found && Array.isArray(legacy.value)) {
    return normalizeWorkspace({ tocItems: legacy.value });
  }
  return normalizeWorkspace(null);
}

export function serializeWorkspace(state) {
  return JSON.stringify(normalizeWorkspace(state));
}

export function saveWorkspace(state, storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    const snapshot =
      state && typeof state === 'object' && Number(state.savedAt) > 0
        ? state
        : { ...state, savedAt: Date.now() };
    store.setItem(WORKSPACE_KEY, serializeWorkspace(snapshot));
    return true;
  } catch (error) {
    console.error('Could not save the workspace:', error);
    return false;
  }
}

const NATIVE_LOAD_COMMAND = 'loadWorkspace';
const NATIVE_SAVE_COMMAND = 'saveWorkspace';

function nativeBinding(name) {
  const scope = globalThis;
  if (typeof scope[name] === 'function') return scope[name];
  const bridge = scope.__webview__;
  if (bridge && typeof bridge.call === 'function') {
    return (...args) => bridge.call(name, ...args);
  }
  return null;
}

/* True when the desktop host exposes the file-backed workspace store. */
export function hasNativeWorkspaceStore() {
  return (
    nativeBinding(NATIVE_LOAD_COMMAND) !== null &&
    nativeBinding(NATIVE_SAVE_COMMAND) !== null
  );
}

/*
 * Loads the workspace written by the native host. Returns a normalized
 * workspace, or null when the binding is missing, the store is empty, or the
 * call failed. localStorage stays the synchronous boot cache.
 */
export async function loadWorkspaceNative() {
  const binding = nativeBinding(NATIVE_LOAD_COMMAND);
  if (!binding) return null;
  try {
    const result = await binding();
    if (result?.ok !== true) return null;
    const workspace = result.workspace;
    if (workspace === null || workspace === undefined) return null;
    return normalizeWorkspace(
      typeof workspace === 'string' ? JSON.parse(workspace) : workspace,
    );
  } catch (error) {
    console.error('Could not load the native workspace:', error);
    return null;
  }
}

let nativeSaveChain = Promise.resolve(false);
let lastNativePayload = null;

/*
 * Queues a serialized workspace write on the native store. Writes run one at a
 * time so an older payload can never land after a newer one, identical
 * payloads are skipped, and the promise resolves to true only when the host
 * confirmed the write.
 */
export function saveWorkspaceNative(payload) {
  const binding = nativeBinding(NATIVE_SAVE_COMMAND);
  if (!binding) return Promise.resolve(false);
  const serialized =
    typeof payload === 'string' ? payload : String(payload ?? '');
  if (serialized === lastNativePayload) return nativeSaveChain;

  nativeSaveChain = nativeSaveChain.then(async () => {
    try {
      const result = await binding(serialized);
      if (result && result.ok === true) {
        lastNativePayload = serialized;
        return true;
      }
      console.error('The native workspace store rejected the payload:', result);
      return false;
    } catch (error) {
      console.error('Could not save the native workspace:', error);
      return false;
    }
  });
  return nativeSaveChain;
}
