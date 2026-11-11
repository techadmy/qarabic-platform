import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { resetMockState } from '@/mocks/handlers';
import { server } from '@/mocks/node';
import { routerMock } from './router-mock';

process.env.NEXT_PUBLIC_API_URL = 'http://api.test';

// `findBy…`/`waitFor` wait up to 3 s (1 s by default): a loaded runner renders the big forms slower.
configure({ asyncUtilTimeout: 3_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => routerMock.pathname,
  useSearchParams: () => new URLSearchParams(routerMock.search),
  notFound: vi.fn(),
}));

// Server action: in tests only the cookie write is skipped.
vi.mock('@/i18n/actions', () => ({ setLocale: vi.fn(async () => undefined) }));

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  // jsdom's AbortSignal is not the one Node's fetch/Request accept; drop it in tests only.
  const patched = globalThis.fetch;
  globalThis.fetch = (input, init) => patched(input, { ...init, signal: undefined });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  // A test that failed before its own cleanup must not leave request listeners for the next one.
  server.events.removeAllListeners();
  resetMockState();
  routerMock.reset();
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});
afterAll(() => server.close());

// jsdom lacks these; Radix and the shadcn sidebar use them.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => undefined;
Element.prototype.setPointerCapture ??= () => undefined;
