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

export const MAX_BROWSER_IMAGES = 500;
export const MAX_BROWSER_IMAGE_SIZE = 16 * 1024 * 1024;

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
  const selected = acceptable.slice(0, MAX_BROWSER_IMAGES);
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
    skipped: Math.max(0, acceptable.length - selected.length),
    oversized: files.length - acceptable.length,
  };
}
