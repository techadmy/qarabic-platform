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
  phone: z.string().nullable(),
  /** The user's role with both labels (docs/29 §2: `/me` carries the role label and kind). */
  role: z
    .object({
      name: z.string(),
      labelAr: z.string(),
      labelEn: z.string().nullable(),
      kind: z.enum(['owner', 'staff', 'teacher', 'parent']),
    })
    .nullable(),
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

/**
 * `PATCH /me`: the signed-in user's own name, language, time zone and phone (D68, D74), and a
 * password change that needs the current password. At least one field.
 */
export const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    locale: z.enum(['ar', 'en']).optional(),
    timezone: z
      .string()
      .trim()
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return tz.length <= 64;
          } catch {
            return false;
          }
        },
        { message: 'Unknown time zone.' },
      )
      .optional(),
    phone: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.replace(/[\s\-().]/g, '') || null : v),
        z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/, {
            message: 'Use the international format, e.g. +447700900123.',
          })
          .nullable(),
      )
      .optional(),
    currentPassword: z.string().transform(cleanCredential).optional(),
    password: newPasswordSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['_'], message: 'Send at least one field.' });
    }
    if (v.password !== undefined && !v.currentPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentPassword'],
        message: 'Enter your current password.',
      });
    }
  });
export type UpdateMeInput = z.input<typeof updateMeSchema>;

/** Standard API error body: `{ message, code, errors? }` (same contract as the Laravel API). */
export const apiErrorSchema = z.object({
  message: z.string(),
  code: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  /** Extra facts about the refusal, e.g. `{ usersCount: 3 }` for `role_in_use`. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
