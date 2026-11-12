import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Reads values Laravel stored with `encrypted` casts (`Crypt::encrypt`): base64 of
 * `{"iv","value","mac","tag"}`, AES-256-CBC, HMAC-SHA256 over `iv . value` with the app key
 * (`APP_KEY=base64:…`). `encrypt()` PHP-serialises the value first (`s:5:"hello";`);
 * `encryptString()` does not. Used only to move meeting links and WhatsApp numbers to the new
 * AES-256-GCM format (the old key is read from `LEGACY_APP_KEY`, never printed).
 */
export class LaravelCipher {
  private readonly key: Buffer;

  constructor(appKey: string) {
    const raw = appKey.startsWith('base64:')
      ? Buffer.from(appKey.slice(7), 'base64')
      : Buffer.from(appKey, 'utf8');
    if (raw.length !== 32)
      throw new Error('LEGACY_APP_KEY must be the 32-byte Laravel APP_KEY (base64:…).');
    this.key = raw;
  }

  /** The plain text, or null when the payload is not Laravel's or the MAC does not match. */
  decrypt(payload: string): string | null {
    let data: { iv?: unknown; value?: unknown; mac?: unknown };
    try {
      data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as typeof data;
    } catch {
      return null;
    }
    if (
      typeof data.iv !== 'string' ||
      typeof data.value !== 'string' ||
      typeof data.mac !== 'string'
    )
      return null;
    const mac = createHmac('sha256', this.key)
      .update(data.iv + data.value)
      .digest();
    const given = Buffer.from(data.mac, 'hex');
    if (given.length !== mac.length || !timingSafeEqual(given, mac)) return null;
    try {
      const decipher = createDecipheriv('aes-256-cbc', this.key, Buffer.from(data.iv, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(data.value, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return unserializeString(plain);
    } catch {
      return null;
    }
  }
}

/** `s:N:"…";` (PHP serialize of a string) → the string; anything else is returned as is. */
export function unserializeString(value: string): string {
  const m = /^s:(\d+):"([\s\S]*)";$/.exec(value);
  if (m && Buffer.byteLength(m[2]!, 'utf8') === Number(m[1])) return m[2]!;
  return value;
}
