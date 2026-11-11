'use client';

import { allPermissions, type RoleDto } from '@qarabic/shared';
import { Badge } from '@qarabic/ui/components/badge';
import type { ColumnDef } from '@tanstack/react-table';
import { CopyIcon, Trash2Icon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useMemo } from 'react';
import { Button } from '@qarabic/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@qarabic/ui/components/tooltip';

export function roleKindKey(role: Pick<RoleDto, 'kind' | 'isSystem'>) {
  return role.kind === 'owner' ? 'owner' : role.isSystem ? 'system' : 'custom';
}

export function roleName(role: Pick<RoleDto, 'labelAr' | 'labelEn'>, locale: string) {
  return locale === 'ar' ? role.labelAr : (role.labelEn ?? role.labelAr);
}

const TOTAL = allPermissions().length;

/** Columns of the roles table (shadcn Data Table pattern). */
export function useRoleColumns({
  canManage,
  onDelete,
}: {
  canManage: boolean;
  onDelete: (role: RoleDto) => void;
}): ColumnDef<RoleDto>[] {
  const t = useTranslations('roles');
  const locale = useLocale();
  return useMemo(
    () => [
      {
        id: 'role',
        header: t('columns.role'),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Link
              href={`/roles/${row.original.id}`}
              className="font-semibold text-primary hover:underline"
            >
              {roleName(row.original, locale)}
            </Link>
            {row.original.description && (
              <span className="line-clamp-1 text-sm text-muted-foreground">
                {row.original.description}
              </span>
            )}
          </div>
        ),
      },
      {
        id: 'kind',
        header: t('columns.kind'),
        cell: ({ row }) => (
          <Badge
            variant={row.original.kind === 'owner' ? 'default' : 'outline'}
            className="h-6 rounded-md"
          >
            {t(`kindChip.${roleKindKey(row.original)}`)}
          </Badge>
        ),
      },
      {
        id: 'users',
        header: t('columns.users'),
        meta: { numeric: true },
        cell: ({ row }) => t('usersCount', { count: row.original.usersCount }),
      },
      {
        id: 'permissions',
        header: t('columns.permissions'),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.kind === 'owner'
              ? t('allPermissions')
              : t('permissionsOf', { count: row.original.permissions.length, total: TOTAL })}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) =>
          row.original.customizedAt ? (
            <Badge variant="secondary" className="rounded-sm" title={t('customizedHint')}>
              {t('customized')}
            </Badge>
          ) : (
            <Badge variant="outline" className="rounded-sm">
              {t('default')}
            </Badge>
          ),
      },
      ...(canManage
        ? [
            {
              id: 'actions',
              header: () => <span className="sr-only">{t('actions')}</span>,
              meta: { className: 'w-0 text-end' },
              cell: ({ row }: { row: { original: RoleDto } }) => (
                <div className="flex justify-end gap-0.5">
                  {row.original.kind === 'staff' && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-sm" asChild>
                          <Link
                            href={`/roles/new?copyFrom=${row.original.id}`}
                            aria-label={t('duplicateRole', {
                              name: roleName(row.original, locale),
                            })}
                          >
                            <CopyIcon />
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('duplicate')}</TooltipContent>
                    </Tooltip>
                  )}
                  {!row.original.isSystem && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive"
                          aria-label={t('deleteRole', { name: roleName(row.original, locale) })}
                          onClick={() => onDelete(row.original)}
                        >
                          <Trash2Icon />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('delete')}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ),
            } satisfies ColumnDef<RoleDto>,
          ]
        : []),
    ],
    [t, locale, canManage, onDelete],
  );
}
