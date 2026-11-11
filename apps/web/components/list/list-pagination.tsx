'use client';

import { Button } from '@qarabic/ui/components/button';
import { Label } from '@qarabic/ui/components/label';
import { Pagination, PaginationContent, PaginationItem } from '@qarabic/ui/components/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import type { PageMeta } from '@qarabic/shared';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { PER_PAGE_OPTIONS } from '@/lib/list-params';

/**
 * Server pagination under a list (docs/15 §5.3: 25/50/100): «1–25 من 42», rows per page, previous /
 * next. shadcn `Pagination` layout with buttons, since the page lives in the URL query.
 */
export function ListPagination({
  meta,
  onPage,
  onPerPage,
}: {
  meta: PageMeta;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}) {
  const t = useTranslations('list');
  const id = useId();
  if (meta.total === 0) return null;
  const from = (meta.page - 1) * meta.perPage + 1;
  const to = Math.min(meta.total, meta.page * meta.perPage);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className="font-normal text-muted-foreground">
          {t('perPage')}
        </Label>
        <Select value={String(meta.perPage)} onValueChange={(v) => onPerPage(Number(v))}>
          <SelectTrigger id={id} size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Pagination className="mx-0 w-auto" aria-label={t('pagination')}>
        <PaginationContent className="gap-2">
          <PaginationItem>
            <span className="text-muted-foreground tabular-nums">
              {t('range', { from, to, total: meta.total })}
            </span>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('previous')}
              disabled={meta.page <= 1}
              onClick={() => onPage(meta.page - 1)}
            >
              <ChevronRightIcon className="ltr:rotate-180" />
            </Button>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="outline"
              size="icon"
              aria-label={t('next')}
              disabled={meta.page >= meta.lastPage}
              onClick={() => onPage(meta.page + 1)}
            >
              <ChevronLeftIcon className="ltr:rotate-180" />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
