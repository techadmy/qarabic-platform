import { cookies } from 'next/headers';
import { Suspense, type ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // shadcn sidebar keeps its open/collapsed state in this cookie; read it so SSR matches.
  const defaultOpen = (await cookies()).get('sidebar_state')?.value !== 'false';
  return (
    <Suspense>
      <AppShell defaultOpen={defaultOpen}>{children}</AppShell>
    </Suspense>
  );
}
