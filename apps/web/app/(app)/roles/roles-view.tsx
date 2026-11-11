'use client';

import type { RoleDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, ShieldCheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchRoles } from '@/lib/api/roles';
import { can } from '@/lib/auth/use-me';
import { useRoleColumns } from './columns';
import { DeleteRoleDialog } from './delete-role-dialog';

export function RolesView() {
  const t = useTranslations('roles');
  const me = useCurrentUser();
  const allowed = can(me, 'roles.view');
  const canManage = can(me, 'roles.manage');
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const onDelete = useCallback((role: RoleDto) => setDeleting(role), []);
  const columns = useRoleColumns({ canManage, onDelete });
  const query = useQuery({
    queryKey: ['roles'],
    queryFn: ({ signal }) => fetchRoles(signal),
    enabled: allowed,
  });

  let body;
  if (!allowed || isApiError(query.error, 403)) {
    body = <ForbiddenState />;
  } else if (query.isError) {
    body = <ErrorState onRetry={() => void query.refetch()} />;
  } else if (!query.isPending && query.data.length === 0) {
    body = (
      <EmptyState icon={ShieldCheckIcon} title={t('empty')} description={t('emptyDescription')} />
    );
  } else {
    body = (
      <DataTable
        columns={columns}
        data={query.data ?? []}
        loading={query.isPending}
        label={t('tableLabel')}
        emptyText={t('empty')}
        getRowHref={(role) => `/roles/${role.id}`}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        meta={query.data ? t('count', { count: query.data.length }) : undefined}
        actions={
          allowed && canManage ? (
            <Button asChild className="h-10 px-4">
              <Link href="/roles/new">
                <PlusIcon />
                {t('new')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {body}
      {deleting && (
        <DeleteRoleDialog
          role={deleting}
          open
          onOpenChange={(open) => !open && setDeleting(null)}
        />
      )}
    </>
  );
}
