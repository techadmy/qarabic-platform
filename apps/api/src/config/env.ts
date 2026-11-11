import { z } from 'zod';

const url = z.url();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    DATABASE_URL: url,
    /** Comma-separated list of browser origins allowed by CORS (credentials on). */
    WEB_ORIGIN: z
      .string()
      .min(1)
      .transform((v) => v.split(',').map((o) => o.trim()))
      .pipe(z.array(url).min(1)),
    /** Base URL of the web app, used for links in mails (password reset). */
    APP_URL: url.optional(),
    /** Signs the CSRF token. At least 32 characters. */
    SESSION_SECRET: z.string().min(32),
    /** e.g. `.qarabic.com` so the web app on another subdomain can read the XSRF cookie. */
    COOKIE_DOMAIN: z.string().min(1).optional(),
    /** Express `trust proxy` (nginx in front): `loopback` by default. */
    TRUST_PROXY: z.string().default('loopback'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .transform((env) => ({ ...env, APP_URL: env.APP_URL ?? env.WEB_ORIGIN[0]! }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && /change-me|dev-only|test-only/i.test(env.SESSION_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'Use a real random secret.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

/** Validates `process.env`; fails fast with the list of bad keys (values are never printed). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${keys}`);
  }
  return parsed.data;
}
