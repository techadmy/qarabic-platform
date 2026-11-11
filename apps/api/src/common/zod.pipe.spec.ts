import { loginSchema } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { ApiException } from './errors.js';
import { ZodPipe } from './zod.pipe.js';

describe('ZodPipe', () => {
  const pipe = new ZodPipe(loginSchema);

  it('returns the parsed (cleaned) value', () => {
    expect(pipe.transform({ email: 'A@b.co', password: '\u200Fpw' })).toEqual({
      email: 'A@b.co',
      password: 'pw',
      remember: true,
    });
  });

  it('maps issues to a 422 errors bag', () => {
    try {
      pipe.transform({ email: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiException);
      const body = (e as ApiException).getResponse() as {
        code: string;
        errors: Record<string, string[]>;
      };
      expect((e as ApiException).getStatus()).toBe(422);
      expect(body.code).toBe('validation_failed');
      expect(Object.keys(body.errors).sort()).toEqual(['email', 'password']);
    }
  });
});
