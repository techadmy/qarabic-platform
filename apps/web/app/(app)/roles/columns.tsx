'use client';

import { Badge } from '@qarabic/ui/components/badge';
import type { ColumnDef } from '@tanstack/react-table';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { RoleRow } from '@/lib/api/roles';

const KNOWN_KINDS = ['owner', 'staff', 'teacher', 'parent', 'system', 'custom'] as const;
type Kind = (typeof KNOWN_KINDS)[number];

/** Columns of the read-only roles table (shadcn Data Table pattern). */
export function useRoleColumns(): ColumnDef<RoleRow>[] {
  const t = useTranslations('roles');
  const locale = useLocale();
  return useMemo(
    () => [
      {
        id: 'role',
        header: t('columns.role'),
        cell: ({ row }) => (
          <span className="font-medium">
            {locale === 'ar' ? row.original.label_ar : row.original.label_en}
          </span>
        ),
      },
      {
        accessorKey: 'kind',
        header: t('columns.kind'),
        cell: ({ row }) => {
          const kind = row.original.kind;
          return (KNOWN_KINDS as readonly string[]).includes(kind)
            ? t(`kind.${kind as Kind}`)
            : kind;
        },
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
          row.original.customized_at ? (
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
