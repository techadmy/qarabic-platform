import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 random bytes, base64url (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * The session a CSRF token belongs to (RBAC-3, docs/39 P2-3): a hash of the session cookie, or
 * `anon` before sign-in. A token minted for one session is refused in another.
 */
export function csrfBinding(sessionCookie: string | undefined | null): string {
  return sessionCookie ? sha256(`session:${sessionCookie}`) : 'anon';
}

/**
 * CSRF token = `nonce.hmac(secret, binding|nonce)`: a cookie planted by a sibling subdomain fails
 * the signature, and a token from another session fails the binding.
 */
export function signCsrf(secret: string, binding: string, nonce = randomToken()): string {
  return `${nonce}.${createHmac('sha256', secret).update(`${binding}|${nonce}`).digest('base64url')}`;
}

export function verifyCsrf(secret: string, binding: string, token: string): boolean {
  const [nonce, sig, ...rest] = token.split('.');
  if (!nonce || !sig || rest.length) return false;
  return safeEqual(signCsrf(secret, binding, nonce), token);
}
