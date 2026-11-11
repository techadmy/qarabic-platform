import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { PasswordsService } from './passwords.service.js';

describe('PasswordsService', () => {
  const svc = new PasswordsService();

  it('hashes with argon2id and verifies', async () => {
    const h = await svc.hash('Secret-123');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'Secret-123')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
    expect(svc.needsRehash(h)).toBe(false);
  });

  it('accepts Laravel bcrypt ($2y$) hashes and flags them for rehash', async () => {
    const laravel = (await bcrypt.hash('Secret-123', 4)).replace(/^\$2b\$/, '$2y$');
    expect(await svc.verify(laravel, 'Secret-123')).toBe(true);
    expect(await svc.verify(laravel, 'wrong')).toBe(false);
    expect(svc.needsRehash(laravel)).toBe(true);
  });

  it('rejects unknown formats and missing users', async () => {
    expect(await svc.verify('plain-text', 'plain-text')).toBe(false);
    expect(await svc.verify(null, 'anything')).toBe(false);
  });
});
