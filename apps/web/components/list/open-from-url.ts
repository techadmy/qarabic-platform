'use client';

import { useEffect } from 'react';
import { useListParams } from '@/lib/list-params';

/**
 * `?new=1` (the sidebar «+», D141 §6, and global links) opens the list's own «add» dialog once,
 * then leaves the URL clean. Does nothing without permission (`enabled`).
 */
export function useOpenFromUrl(enabled: boolean, open: () => void) {
  const params = useListParams();
  const asked = params.get('new') === '1';
  useEffect(() => {
    if (!asked) return;
    if (enabled) open();
    params.set({ new: null }, { resetPage: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per `?new=1`
  }, [asked, enabled]);
}
