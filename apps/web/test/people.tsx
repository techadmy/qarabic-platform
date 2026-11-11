import type { ReactElement } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { mockSignIn } from '@/mocks/handlers';
import { renderWithProviders } from './render';
import { routerMock } from './router-mock';

/** Signs a mock user in and renders a page inside the app shell at `path` (`/families?status=trial`). */
export function renderPage(ui: ReactElement, { as = 'admin@qarabic.test', path = '/' } = {}) {
  mockSignIn(as);
  const [pathname, search = ''] = path.split('?');
  routerMock.pathname = pathname!;
  routerMock.search = search;
  return renderWithProviders(<AppShell defaultOpen>{ui}</AppShell>);
}

/** The last URL the list pushed into the address bar (`router.replace`). */
export function lastReplacedUrl(): URL {
  const calls = routerMock.replace.mock.calls;
  const last = calls[calls.length - 1]?.[0] as string | undefined;
  return new URL(last ?? '/', 'http://app.test');
}
