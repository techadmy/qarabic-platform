import { NextResponse, type NextRequest } from 'next/server';
import { apiOriginOf, contentSecurityPolicy } from '@/lib/security/csp';

/**
 * Every page gets a fresh nonce and the Content-Security-Policy that uses it (docs/39 P0-2): Next
 * reads the policy from the request headers and puts the nonce on its own scripts.
 * Development-only pages (`/dev/*`, the RTL spike) answer a real 404 in production builds; the
 * page itself also calls `notFound()`, but a streamed page keeps status 200.
 */
export function proxy(request: NextRequest) {
  const dev = process.env.NODE_ENV !== 'production';
  const { pathname } = request.nextUrl;
  if (!dev && (pathname === '/dev' || pathname.startsWith('/dev/'))) {
    return new NextResponse('Not found', { status: 404 });
  }
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy({
    nonce,
    apiOrigin: apiOriginOf(process.env.NEXT_PUBLIC_API_URL),
    dev,
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Pages only: not static files, images, the service worker or prefetches (which reuse the page's).
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|brand/|mockServiceWorker.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
