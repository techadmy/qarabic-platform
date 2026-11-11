import { vi } from 'vitest';

/** Mutable `next/navigation` router used by the unit tests. */
export const routerMock = {
  pathname: '/',
  search: '',
  replace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
  reset() {
    this.pathname = '/';
    this.search = '';
    this.replace.mockReset();
    this.push.mockReset();
    this.refresh.mockReset();
  },
};
