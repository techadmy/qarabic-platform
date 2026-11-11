import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

const PREFIX = 'v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptError extends Error {
  constructor() {
    super('The stored value cannot be decrypted (wrong key or tampered data).');
  }
}

/**
 * AES-256-GCM for secrets at rest (meeting join / start links let anyone into a child's class;
 * Laravel stored them with `encrypted` casts). Stored form: `v1:` + base64(iv ‖ tag ‖ ciphertext).
 * A fresh random IV per value; GCM's tag makes any change to the stored text fail to decrypt.
 */
export class FieldCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('The encryption key must be 32 bytes.');
  }

  static fromBase64(key: string): FieldCipher {
    return new FieldCipher(Buffer.from(key, 'base64'));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  /** null stays null; anything not ours, tampered or under another key throws `DecryptError`. */
  decrypt(stored: string): string {
    if (!stored.startsWith(PREFIX)) throw new DecryptError();
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new DecryptError();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DecryptError();
    }
  }

  encryptOrNull(plain: string | null | undefined): string | null {
    return plain ? this.encrypt(plain) : null;
  }
}

/** The app's cipher (`APP_ENCRYPTION_KEY`). `tryDecrypt` logs and answers null on a bad value. */
@Injectable()
export class Crypto extends FieldCipher {
  private readonly logger = new Logger('Crypto');

  constructor(@Inject(ENV) env: Env) {
    super(Buffer.from(env.APP_ENCRYPTION_KEY, 'base64'));
  }

  tryDecrypt(stored: string | null | undefined): string | null {
    if (!stored) return null;
    try {
      return this.decrypt(stored);
    } catch {
      this.logger.error('An encrypted value could not be decrypted (wrong key or tampered data).');
      return null;
    }
  }
}

@Global()
@Module({ providers: [Crypto], exports: [Crypto] })
export class CryptoModule {}
