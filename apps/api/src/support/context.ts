/**
 * Keeps only the known, harmless keys of the client context sent with a report (docs/22 §5.1),
 * port of Laravel `ContextSanitizer`: no form values, tokens or cookies; strings are capped and
 * secrets are removed from the page URL's query. Accepts camelCase (this API) and the Laravel
 * snake_case keys (old clients).
 */
const STRING_KEYS: Record<string, number> = {
  pageUrl: 500,
  route: 120,
  appVersion: 60,
  userAgent: 400,
  platform: 60,
  viewport: 20,
  screen: 20,
  timeZone: 64,
  displayZone: 64,
  locale: 10,
  portal: 20,
  area: 40,
};

const SECRET_PARAMS = new Set([
  'token',
  'access_token',
  'password',
  'signature',
  'code',
  'email',
  'phone',
  'key',
]);

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function pick(source: Record<string, unknown>, key: string): unknown {
  return source[key] ?? source[snake(key)];
}

function cap(value: string, max: number): string {
  return [...value.trim()].slice(0, max).join('');
}

export function cleanContext(input: unknown): Record<string, unknown> {
  const context =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const [key, max] of Object.entries(STRING_KEYS)) {
    const value = pick(context, key);
    if (
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      String(value) !== ''
    ) {
      out[key] = cap(String(value), max);
    }
  }
  if (typeof out.pageUrl === 'string') out.pageUrl = stripSecrets(out.pageUrl);
  for (const flag of ['online', 'touch']) {
    if (flag in context) {
      const v = context[flag];
      out[flag] = v === true || v === 1 || v === '1' || v === 'true';
    }
  }
  const rawErrors = pick(context, 'recentErrors');
  const errors: Array<Record<string, unknown>> = [];
  for (const e of Array.isArray(rawErrors) ? rawErrors.slice(0, 10) : []) {
    if (!e || typeof e !== 'object') continue;
    const row = e as Record<string, unknown>;
    const str = (k: string, max: number) => {
      const v = pick(row, k);
      return typeof v === 'string' || typeof v === 'number' ? cap(String(v), max) : '';
    };
    const status = pick(row, 'status');
    const clean: Record<string, unknown> = {
      method: str('method', 8).toUpperCase(),
      path: str('path', 400).split('?')[0]!.slice(0, 200),
      status: typeof status === 'number' || /^\d+$/.test(String(status)) ? Number(status) : null,
      requestId: str('requestId', 64),
      at: str('at', 30),
    };
    errors.push(
      Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null && v !== '')),
    );
  }
  if (errors.length) out.recentErrors = errors;
  return out;
}

/** Path + query without secret parameters (the origin is dropped). */
function stripSecrets(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://local.invalid');
  } catch {
    return '';
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  const qs = parsed.searchParams.toString();
  return parsed.pathname + (qs ? `?${qs}` : '');
}
