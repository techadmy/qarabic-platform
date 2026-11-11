import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://u@localhost:5433/db',
  WEB_ORIGIN: 'http://localhost:3000, http://127.0.0.1:3000',
  SESSION_SECRET: 'x'.repeat(40),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};
const realKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString('base64');

describe('loadEnv', () => {
  it('applies defaults and splits origins', () => {
    const env = loadEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('fails without printing values', () => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short-secret' })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...base, SESSION_SECRET: 'short-secret' })).not.toThrow(/short-secret/);
  });

  it('rejects placeholder secrets in production', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        SESSION_SECRET: 'change-me-to-32-or-more-random-characters',
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('needs a 32-byte base64 encryption key, and a real one in production', () => {
    expect(() => loadEnv({ ...base, APP_ENCRYPTION_KEY: undefined })).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, APP_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(
      /APP_ENCRYPTION_KEY/,
    );
    expect(() => loadEnv({ ...base, APP_ENCRYPTION_KEY: 'c2hvcnQ=' })).not.toThrow(/c2hvcnQ/);
    const prod = {
      ...base,
      NODE_ENV: 'production',
      SESSION_SECRET: 'r'.repeat(10) + 'q'.repeat(30),
    };
    expect(() =>
      loadEnv({ ...prod, APP_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
    ).toThrow(/APP_ENCRYPTION_KEY/);
    expect(loadEnv({ ...prod, APP_ENCRYPTION_KEY: realKey }).APP_ENCRYPTION_KEY).toBe(realKey);
  });
});
