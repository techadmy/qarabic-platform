'use client';

import { LayoutDashboardIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/states';

/** Home placeholder until the first modules land (N1+): page title + shadcn `Empty`. */
export function HomeView() {
  const t = useTranslations('home');
  const me = useCurrentUser();
  return (
    <>
      <PageHeader title={t('welcome', { name: me.name })} />
      <EmptyState
        icon={LayoutDashboardIcon}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    </>
  );
}
