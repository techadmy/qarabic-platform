'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BASE_PATH } from '@/lib/base-path';

const MOCKS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MOCKS === 'true';

let starting: Promise<unknown> | null = null;
function startMocks() {
  // Once per page load, also under React strict mode's double effects.
  starting ??= import('@/mocks/browser').then(({ worker }) =>
    worker.start({
      onUnhandledRequest: 'bypass',
      quiet: true,
      serviceWorker: { url: `${BASE_PATH}/mockServiceWorker.js` },
    }),
  );
  return starting;
}

/**
 * Optional mock mode (`NEXT_PUBLIC_ENABLE_MOCKS=true`): starts the MSW service worker before the
 * app makes its first request. When mocks are off this renders its children directly and the MSW
 * code is never loaded.
 */
export function MockGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(!MOCKS_ENABLED);
  useEffect(() => {
    if (!MOCKS_ENABLED) return;
    void startMocks().then(() => setReady(true));
  }, []);
  return ready ? children : null;
}
