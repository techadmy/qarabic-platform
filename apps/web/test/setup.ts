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

/**
 * The mocks build "today" from the clock (past classes taken, one running, one late, the rest to
 * come). Unit tests pin the clock to 12:00 Cairo of the real date, so they pass at any hour (just
 * after midnight no class has finished yet). Only `Date` is faked; timers stay real.
 */
export const PINNED_NOW = new Date(
  `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date())}T10:00:00Z`,
);
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(PINNED_NOW);

beforeAll(() => {
  resetMockState();
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
afterAll(async () => {
  server.close();
  // sonner removes a closed toast 200 ms later (TIME_BEFORE_UNMOUNT); let that timer run while
  // jsdom still exists, or it throws "window is not defined" after teardown under a loaded runner.
  await new Promise((resolve) => setTimeout(resolve, 250));
});

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
