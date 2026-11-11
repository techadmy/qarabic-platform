import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanFileName, LocalDiskStorage, sniffImage } from './storage.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('ticket file storage', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it('recognises PNG, JPEG and WebP from the bytes only', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'binary'))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('stores, reads and deletes under its folder, and refuses keys that leave it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qarabic-storage-'));
    dirs.push(dir);
    const disk = new LocalDiskStorage(dir);
    await disk.put('tickets/1/a.png', PNG);
    expect(await disk.get('tickets/1/a.png')).toEqual(PNG);
    await disk.delete('tickets/1/a.png');
    expect(await disk.get('tickets/1/a.png')).toBeNull();
    await expect(disk.put('../escape.png', PNG)).rejects.toThrow('Invalid storage key');
    await expect(disk.get('/etc/passwd')).rejects.toThrow('Invalid storage key');
  });

  it('cleans display names', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('صورة <1>.png')).toBe('صورة _1_.png');
    expect([...cleanFileName('a'.repeat(300))].length).toBe(150);
  });
});
