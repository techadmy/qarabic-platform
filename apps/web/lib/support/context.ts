import type { TicketContext } from '@qarabic/shared';
import { recentApiErrors } from './error-log';

/** Build id, shown to triage so they know which release a report is about. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/**
 * Everything sent automatically with a request (docs/22 §5.1): the page, the device, both zones,
 * the language and the last failed API calls. No form values, cookies or tokens; the user and
 * role come from the session on the server.
 */
export function collectContext(opts: {
  pathname: string;
  search: string;
  /** The zone the app shows times in (the account's, else the browser's). */
  displayZone: string;
  locale: string;
  portal: string | null;
}): TicketContext {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const area =
    (opts.pathname.split('/').filter(Boolean)[0] ?? 'home')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40) || 'home';
  return {
    pageUrl: `${opts.pathname}${opts.search}`,
    route: opts.pathname,
    area,
    ...(opts.portal ? { portal: opts.portal } : {}),
    appVersion: APP_VERSION,
    userAgent: nav?.userAgent,
    platform:
      (nav as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData
        ?.platform ?? nav?.platform,
    viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '',
    screen: typeof window !== 'undefined' ? `${window.screen.width}x${window.screen.height}` : '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    displayZone: opts.displayZone,
    locale: opts.locale,
    online: nav?.onLine ?? true,
    touch: (nav?.maxTouchPoints ?? 0) > 0,
    recentErrors: recentApiErrors(),
  };
}
