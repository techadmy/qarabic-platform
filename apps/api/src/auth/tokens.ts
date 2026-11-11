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

/** CSRF token = `nonce.hmac(secret, nonce)`: a cookie planted by a sibling subdomain fails the signature. */
export function signCsrf(secret: string, nonce = randomToken()): string {
  return `${nonce}.${createHmac('sha256', secret).update(nonce).digest('base64url')}`;
}

export function verifyCsrf(secret: string, token: string): boolean {
  const [nonce, sig, ...rest] = token.split('.');
  if (!nonce || !sig || rest.length) return false;
  return safeEqual(signCsrf(secret, nonce), token);
}
