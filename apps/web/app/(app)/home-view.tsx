'use client';

import { LayoutDashboardIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StaffHomeView } from '@/components/operations/staff-home';
import { EmptyState } from '@/components/states';
import { can } from '@/lib/auth/use-me';
import { TeacherHomeView } from '@/components/portal/teacher-home';
import { ParentHomeView } from '@/components/support/parent-home-view';

/**
 * The parent's home (N4, `GET /parent/home`), the teacher's «يومي» (M9) and the staff dashboard
 * (M8, `GET /dashboard/summary`, `reports.view`); others keep the placeholder.
 */
export function HomeView() {
  const me = useCurrentUser();
  if (me.role?.kind === 'parent') return <ParentHomeView />;
  if (me.role?.kind === 'teacher') return <TeacherHomeView />;
  if (can(me, 'reports.view')) return <StaffHomeView />;
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
