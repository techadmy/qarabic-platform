import { z } from 'zod';

/** Strip invisible bidi/zero-width marks that come with a copied credential (pilot bug, 2026-11-11). */
const INVISIBLE = /[­​-‏‪-‮⁠-⁩﻿]/g;
export function cleanCredential(value: string): string {
  return value.replace(INVISIBLE, '').replace(/ /g, ' ').trim();
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
