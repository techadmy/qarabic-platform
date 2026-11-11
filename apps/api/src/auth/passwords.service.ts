import { Injectable } from '@nestjs/common';
import { type Algorithm, hash, verify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';

/** `Algorithm.Argon2id` (a const enum, not usable under isolatedModules). */
const ARGON2ID = 2 as Algorithm;
const BCRYPT = /^\$2[aby]\$\d{2}\$/;

/**
 * argon2id for every new hash. Bcrypt hashes carried over from Laravel (`$2y$`, N8 data move) are
 * still accepted; the caller re-hashes them after a successful login (`needsRehash`).
 */
@Injectable()
export class PasswordsService {
  /** Verified against when the email is unknown, so both paths cost the same time. */
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password, { algorithm: ARGON2ID });
  }

  async verify(storedHash: string | null, password: string): Promise<boolean> {
    if (!storedHash) {
      this.dummy ??= this.hash('qarabic-timing-equaliser');
      await verify(await this.dummy, password).catch(() => false);
      return false;
    }
    if (BCRYPT.test(storedHash)) {
      // `$2y$` (PHP) and `$2b$` are the same algorithm.
      return bcrypt.compare(password, storedHash.replace(/^\$2y\$/, '$2b$'));
    }
    if (storedHash.startsWith('$argon2')) {
      return verify(storedHash, password).catch(() => false);
    }
    return false;
  }

  needsRehash(storedHash: string): boolean {
    return !storedHash.startsWith('$argon2id$');
  }
}
