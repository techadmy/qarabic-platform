/**
 * The web app's Content-Security-Policy (docs/39 P0-2). The frontend owns the CSP; nginx owns
 * HSTS, nosniff, Referrer-Policy, X-Frame-Options and Permissions-Policy, and adds a second,
 * minimal CSP (`frame-ancestors 'none'; base-uri 'self'; object-src 'none'`) that can only tighten
 * this one (browsers enforce both).
 *
 * Scripts: a per-request nonce with 'strict-dynamic' (Next adds the nonce to its own scripts when
 * the request carries this header). Styles: 'unsafe-inline' stays for style attributes (Radix
 * positions popovers with inline styles). Data: same origin and the API (calls, attachments).
 */
export function contentSecurityPolicy({
  nonce,
  apiOrigin,
  dev,
}: {
  nonce: string;
  apiOrigin: string | null;
  dev: boolean;
}): string {
  const api = apiOrigin ? ` ${apiOrigin}` : '';
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:${api}`,
    `font-src 'self'`,
    `connect-src 'self'${api}${dev ? ' ws: wss:' : ''}`,
    `worker-src 'self'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  // Only when the API itself is https: the server rehearsal (docs/36 §5) and the e2e builds run a
  // production build against http://localhost, where upgrading would break every call.
  if (!dev && apiOrigin?.startsWith('https://')) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** The API's origin (scheme + host + port) from `NEXT_PUBLIC_API_URL`, or null when relative. */
export function apiOriginOf(apiUrl: string | undefined): string | null {
  if (!apiUrl) return null;
  try {
    return new URL(apiUrl).origin;
  } catch {
    return null;
  }
}
