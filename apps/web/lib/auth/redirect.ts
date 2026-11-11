/**
 * Where to go after login. Only same-site relative paths are accepted (no `//evil.com`,
 * no `https://…`), so the `next` parameter cannot be used as an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/login')) return '/';
  return next;
}

export function loginPathFor(pathname: string, search = ''): string {
  const target = `${pathname}${search}`;
  return target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`;
}
