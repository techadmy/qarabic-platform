'use client';

import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchRoles } from '@/lib/api/roles';
import { can } from '@/lib/auth/use-me';
import { useRoleColumns } from './columns';

export function RolesView() {
  const t = useTranslations('roles');
  const me = useCurrentUser();
  const allowed = can(me, 'roles.view');
  const columns = useRoleColumns();
  const query = useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => fetchRoles(signal),
    enabled: allowed,
  });

  let body;
  if (!allowed || isApiError(query.error, 403)) {
    body = <ForbiddenState />;
  } else if (query.isPending) {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  } else if (query.isError) {
    body = <ErrorState onRetry={() => void query.refetch()} />;
  } else if (query.data.length === 0) {
    body = (
      <EmptyState icon={ShieldCheckIcon} title={t('empty')} description={t('emptyDescription')} />
    );
  } else {
    body = (
      <DataTable
        columns={columns}
        data={query.data}
        label={t('tableLabel')}
        emptyText={t('empty')}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={query.data ? t('count', { count: query.data.length }) : undefined}
      />
      {body}
    </>
  );
}
