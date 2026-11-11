import { z } from 'zod';

/** Strip invisible bidi/zero-width marks that come with a copied credential (pilot bug, 2026-11-11). */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export function cleanCredential(value: string): string {
  return value
    .replace(INVISIBLE, '')
    .replace(/\u00A0/g, ' ')
    .trim();
}

export const loginSchema = z.object({
  email: z.string().transform(cleanCredential).pipe(z.email()),
  password: z.string().transform(cleanCredential).pipe(z.string().min(1)),
  remember: z.boolean().default(true),
});
export type LoginInput = z.input<typeof loginSchema>;

export const meSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  locale: z.enum(['ar', 'en']),
  timezone: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type Me = z.infer<typeof meSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().transform(cleanCredential).pipe(z.email()),
});
export type ForgotPasswordInput = z.input<typeof forgotPasswordSchema>;

/** New passwords: 8–128 characters (argon2 has no 72-byte limit, but we cap the work per request). */
export const newPasswordSchema = z
  .string()
  .transform(cleanCredential)
  .pipe(z.string().min(8).max(128));

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: newPasswordSchema,
});
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;

/** Standard API error body: `{ message, code, errors? }` (same contract as the Laravel API). */
export const apiErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
