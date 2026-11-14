/** A fixed origin to resolve against: only what stays on it is a same-site path. */
const ORIGIN = 'https://app.invalid';
// Tab, newline and other control characters are dropped by URL parsing (`/\t/evil.com` becomes
// `//evil.com`), and browsers treat `\` like `/`.
const UNSAFE = /[\u0000-\u001f\u007f]/;

/** `value` decoded until it stops changing (at most 3 times), or null when it is malformed. */
function decoded(value: string): string | null {
  let current = value;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Where to go after login (docs/39 P0-1). Only a same-site path is accepted: it must start with a
 * single `/`, carry no control characters (raw or percent-encoded), no `\` before its query, and
 * still be on the app's origin once resolved with `new URL(next, origin)`. Anything else — and the
 * login page itself — goes home, so `next` cannot be used as an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/')) return '/';
  const plain = decoded(next);
  if (plain === null || UNSAFE.test(plain) || UNSAFE.test(next)) return '/';
  const beforeQuery = (s: string) => s.split(/[?#]/, 1)[0]!;
  if (beforeQuery(plain).includes('\\') || beforeQuery(plain).startsWith('//')) return '/';
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== ORIGIN) return '/';
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

export function loginPathFor(pathname: string, search = ''): string {
  const target = `${pathname}${search}`;
  return target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`;
}
