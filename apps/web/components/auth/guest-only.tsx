'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { safeNextPath } from '@/lib/auth/redirect';
import { useMe } from '@/lib/auth/use-me';

/** Auth pages: a signed-in user goes to `?next=` (same-site paths only) or home. */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get('next'));
  useEffect(() => {
    if (me) router.replace(next);
  }, [me, next, router]);
  return children;
}
