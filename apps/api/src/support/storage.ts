// The storage drivers moved to `common/storage.ts` (global `StorageModule`, docs/17 §5).
export { FileStorage, LocalDiskStorage } from '../common/storage.js';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
};

export const extensionFor = (mime: string): string => EXTENSIONS[mime.toLowerCase()] ?? 'bin';

/**
 * The image type from the file's first bytes (PNG, JPEG, WebP), or null. The client's file name
 * and Content-Type are never trusted: an SVG or HTML file renamed `.png` is refused.
 */
export function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** A safe display name: letters, digits, `._ -`, at most 150 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return [...base.replace(/[^\p{L}\p{N}._ -]+/gu, '_')].slice(0, 150).join('') || 'file';
}
