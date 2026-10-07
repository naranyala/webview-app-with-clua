/*
 * Pure helpers for the Image Viewer: which files count as images, how they
 * group into folders, and how a browser FileList becomes thumbnails under the
 * same limits the native directory scan enforces.
 *
 * The browser path is the fallback for a preview with no host, so it is also the
 * one that cannot downscale natively. It uses createImageBitmap plus a canvas
 * when the environment has them, and falls back to the original bytes when it
 * does not — see makeThumbnail.
 */

export const IMAGE_EXTENSIONS = [
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
];

export const IMAGE_MIME_TYPES = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

/*
 * The same three budgets the native directory scan enforces
 * (image_directory.c: IMAGE_SCAN_MAX_FILES / _MAX_FILE_SIZE / _MAX_TOTAL_SIZE).
 * Without the total one, 500 files of 16 MB each became ~8 GB of base64 data
 * URLs in the browser fallback.
 */
export const MAX_BROWSER_IMAGES = 500;
export const MAX_BROWSER_IMAGE_SIZE = 16 * 1024 * 1024;
export const MAX_BROWSER_TOTAL_SIZE = 96 * 1024 * 1024;

/*
 * The longest edge the grid's thumbnail has, matching
 * IMAGE_THUMBNAIL_MAX_EDGE in image_directory.c. The grid cell is 140px tall
 * (`.image-thumbnail img`), so 320 leaves it room to grow on a hidpi display
 * without being visibly soft.
 */
export const THUMBNAIL_MAX_EDGE = 320;

/*
 * Produces a downscaled data URL for one File, or null when the environment
 * cannot: no createImageBitmap, no canvas, or a format the browser will not
 * decode. A null result makes the caller fall back to the original bytes, which
 * is correct but expensive — the same fallback the native scan counts as
 * `fallbacks` in its reply.
 *
 * Injected rather than reached for directly so this module stays free of DOM
 * globals, which is what lets the same helpers be unit tested in plain node. The
 * session passes the real implementations; a test passes none and gets the
 * fallback.
 */
export function makeThumbnail(createBitmap, documentRef) {
  return async function thumbnailOf(file) {
    if (typeof createBitmap !== 'function' || !documentRef?.createElement) {
      return null;
    }
    let bitmap = null;
    try {
      bitmap = await createBitmap(file);
      const width = bitmap.width;
      const height = bitmap.height;
      const longest = Math.max(width, height);
      if (!width || !height) return null;
      if (longest <= THUMBNAIL_MAX_EDGE) {
        // Already small: keep the original rather than re-encoding it smaller.
        return { dataUrl: null, width, height };
      }
      const scale = THUMBNAIL_MAX_EDGE / longest;
      const canvas = documentRef.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      // JPEG has no alpha, so flatten onto white the way the native path does.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return {
        dataUrl: canvas.toDataURL('image/jpeg', 0.82),
        width: canvas.width,
        height: canvas.height,
      };
    } catch {
      return null;
    } finally {
      bitmap?.close?.();
    }
  };
}

export function imageExtension(path) {
  const normalized = String(path || '').toLowerCase();
  return (
    IMAGE_EXTENSIONS.find((extension) => normalized.endsWith(extension)) || ''
  );
}

export function imageGroupFromRelativePath(relativePath) {
  const segments = String(relativePath || '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean);
  segments.pop();
  return segments.length > 0 ? segments.join(' / ') : 'Root';
}

export function groupImages(images) {
  const groups = [{ name: 'All Images', images: [] }];
  const byName = new Map();
  for (const image of images) {
    const name = image.group || imageGroupFromRelativePath(image.relativePath);
    groups[0].images.push(image);
    let group = byName.get(name);
    if (!group) {
      group = { name, images: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.images.push(image);
  }
  return groups;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      'load',
      () => resolve(String(reader.result || '')),
      { once: true },
    );
    reader.addEventListener('error', () => reject(reader.error), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

export async function imagesFromFileList(fileList, options = {}) {
  const thumbnail = options.thumbnail || (async () => null);
  const files = Array.from(fileList || []).filter((file) =>
    imageExtension(file.name),
  );
  const acceptable = files.filter(
    (file) => file.size <= MAX_BROWSER_IMAGE_SIZE,
  );
  /*
   * Take files while both the count and the running byte total fit, which is
   * how the native scan stops. accepted[] and total let the caller say how
   * many were dropped instead of silently truncating.
   */
  const accepted = [];
  let total = 0;
  for (const file of acceptable) {
    if (accepted.length >= MAX_BROWSER_IMAGES) break;
    if (total + file.size > MAX_BROWSER_TOTAL_SIZE) break;
    accepted.push(file);
    total += file.size;
  }
  const selected = accepted;
  const images = await Promise.all(
    selected.map(async (file) => {
      /*
       * Thumbnail first, original only if that fails. The original is the
       * expensive path this whole change is about: base64 costs 33% over the
       * bytes, so a browser-side collection of large photos was ~120 MB resident
       * for the session to fill 187x140 cells.
       */
      const thumb = await thumbnail(file);
      let dataUrl = thumb?.dataUrl || null;
      let fellBack = false;
      if (!dataUrl) {
        dataUrl = await readFileAsDataUrl(file);
        fellBack = true;
      }
      const browserPath = (file.webkitRelativePath || file.name).replaceAll(
        '\\',
        '/',
      );
      const pathSegments = browserPath.split('/').filter(Boolean);
      const relativePath =
        pathSegments.length > 1 ? pathSegments.slice(1).join('/') : browserPath;
      return {
        name: file.name,
        relativePath,
        group: imageGroupFromRelativePath(relativePath),
        size: file.size,
        // The grid reads `thumbnail`; `dataUrl` is the same string kept as an
        // alias so a host that has not been rebuilt still renders.
        thumbnail: dataUrl,
        dataUrl,
        width: thumb?.width || 0,
        height: thumb?.height || 0,
        fellBack,
      };
    }),
  );
  return {
    images,
    groups: groupImages(images),
    totalBytes: total,
    // Everything acceptable that the count or byte budget refused.
    skipped: Math.max(0, acceptable.length - selected.length),
    oversized: files.length - acceptable.length,
    // Images still carrying full-resolution bytes, for the same reason the
    // native scan reports it: a non-zero count means the memory is still spent.
    fallbacks: images.filter((image) => image.fellBack).length,
  };
}
