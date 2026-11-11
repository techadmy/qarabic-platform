import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Private file storage behind one interface (D102): the local disk in development and tests,
 * S3 / DigitalOcean Spaces later (same keys). Files are never public: they are streamed by an
 * authenticated route after the ticket policy.
 */
export abstract class FileStorage {
  abstract put(key: string, bytes: Buffer): Promise<void>;
  /** null when the file is missing. */
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
}

/** Files under `STORAGE_LOCAL_DIR`; a key can never leave that folder. */
export class LocalDiskStorage extends FileStorage {
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) {
      throw new Error('Invalid storage key.');
    }
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key.');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** The configured storage (`STORAGE_DRIVER`; only `local` until Spaces is set up). */
@Injectable()
export class AppFileStorage extends LocalDiskStorage {
  constructor(@Inject(ENV) env: Env) {
    super(env.STORAGE_LOCAL_DIR);
  }
}

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
