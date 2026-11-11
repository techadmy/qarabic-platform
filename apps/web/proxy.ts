import { NextResponse, type NextRequest } from 'next/server';

/**
 * Development-only pages (`/dev/*`, the RTL spike) answer a real 404 in production builds.
 * The page itself also calls `notFound()`, but a streamed page keeps status 200.
 */
export function proxy(_request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return new NextResponse('Not found', { status: 404 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/dev/:path*'] };
