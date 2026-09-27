/*
 * Pure helpers for the Image Viewer: which files count as images, how they
 * group into folders, and how a browser FileList becomes data URLs under the
 * same limits the native directory scan enforces.
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

export async function imagesFromFileList(fileList) {
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
      const dataUrl = await readFileAsDataUrl(file);
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
        dataUrl,
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
  };
}
