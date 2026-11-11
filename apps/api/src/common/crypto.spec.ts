import { describe, expect, it } from 'vitest';
import { DecryptError, FieldCipher } from './crypto.js';

const cipher = new FieldCipher(Buffer.alloc(32, 3));

describe('FieldCipher (AES-256-GCM)', () => {
  it('round-trips and never stores the plain text', () => {
    const stored = cipher.encrypt('https://meet.example.test/abc?pwd=secret');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('meet.example.test');
    expect(cipher.decrypt(stored)).toBe('https://meet.example.test/abc?pwd=secret');
    // a fresh IV every time
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('refuses tampered text, plain text and another key', () => {
    const stored = cipher.encrypt('https://zoom.us/j/1');
    const raw = Buffer.from(stored.slice(3), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 1, raw.length - 1);
    expect(() => cipher.decrypt(`v1:${raw.toString('base64')}`)).toThrow(DecryptError);
    expect(() => cipher.decrypt('https://zoom.us/j/1')).toThrow(DecryptError);
    expect(() => cipher.decrypt('v1:AAAA')).toThrow(DecryptError);
    expect(() => new FieldCipher(Buffer.alloc(32, 4)).decrypt(stored)).toThrow(DecryptError);
  });
});
