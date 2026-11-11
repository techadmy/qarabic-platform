import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { AuthPage } from '@/components/auth/auth-page';
import { GuestOnly } from '@/components/auth/guest-only';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <AuthPage>
      <Suspense>
        <GuestOnly>{children}</GuestOnly>
      </Suspense>
    </AuthPage>
  );
}
