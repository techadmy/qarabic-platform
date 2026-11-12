'use client';

import { LayoutDashboardIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/states';
import { TeacherHomeView } from '@/components/portal/teacher-home';
import { ParentHomeView } from '@/components/support/parent-home-view';

/**
 * The parent's home (N4, `GET /parent/home`) and the teacher's «يومي» (M9); staff keep the
 * placeholder until their dashboards.
 */
export function HomeView() {
  const me = useCurrentUser();
  if (me.role?.kind === 'parent') return <ParentHomeView />;
  if (me.role?.kind === 'teacher') return <TeacherHomeView />;
  return <Placeholder />;
}

/** Home placeholder until the first modules land (N1+): page title + shadcn `Empty`. */
function Placeholder() {
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
