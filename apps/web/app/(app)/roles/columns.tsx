'use client';

import { Badge } from '@qarabic/ui/components/badge';
import type { ColumnDef } from '@tanstack/react-table';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { RoleDto } from '@qarabic/shared';

/** Columns of the read-only roles table (shadcn Data Table pattern). */
export function useRoleColumns(): ColumnDef<RoleDto>[] {
  const t = useTranslations('roles');
  const locale = useLocale();
  return useMemo(
    () => [
      {
        id: 'role',
        header: t('columns.role'),
        cell: ({ row }) => (
          <span className="font-medium">
            {locale === 'ar' ? row.original.labelAr : row.original.labelEn}
          </span>
        ),
      },
      {
        accessorKey: 'kind',
        header: t('columns.kind'),
        cell: ({ row }) => t(`kind.${row.original.kind}`),
      },
      {
        id: 'permissions',
        header: t('columns.permissions'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {t('permissionsCount', { count: row.original.permissions.length })}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) =>
          row.original.customizedAt ? (
            <Badge variant="secondary" title={t('customizedHint')}>
              {t('customized')}
            </Badge>
          ) : (
            <Badge variant="outline">{t('default')}</Badge>
          ),
      },
    ],
    [t, locale],
  );
}
