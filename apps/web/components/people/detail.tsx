'use client';

import type { ArchiveInfo, StatusHistoryEntry } from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Avatar, AvatarFallback } from '@qarabic/ui/components/avatar';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { ArchiveIcon, PencilIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useCurrentUser } from '@/components/shell/app-shell';
import type { PeopleKind } from '@/lib/api/people';
import { statusLabel } from '@/lib/people/kinds';
import { formatInstant } from '@/lib/time';

/** First letter of the name, as on the current app's avatars. */
export function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '';
}

export function ProfileAvatar({ name }: { name: string }) {
  return (
    <Avatar className="size-12 after:border-0">
      <AvatarFallback className="bg-primary text-lg font-medium text-primary-foreground">
        {initial(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Key facts under the header (docs/28 §5): up to four shadcn Cards with a value and its label. */
export function KeyFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} size="sm" className="gap-1 px-4 shadow-none">
          <dt className="order-2 text-sm text-muted-foreground">{item.label}</dt>
          <dd className="order-1 text-lg font-bold tabular-nums">{item.value}</dd>
        </Card>
      ))}
    </dl>
  );
}

export type InfoRow = { label: string; value: ReactNode; wide?: boolean };

/**
 * A titled section of label | value pairs (docs/28 §5): a shadcn Card holding a definition list
 * with a fixed label column, empty values as «غير مسجّل», an «تعديل» shortcut in the card action.
 */
export function InfoSection({
  title,
  rows,
  onEdit,
  className,
}: {
  title: string;
  rows: InfoRow[];
  onEdit?: () => void;
  className?: string;
}) {
  const t = useTranslations('people');
  return (
    <Card className={cn('gap-2 shadow-none', className)}>
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{title}</CardTitle>
        {onEdit && (
          <CardAction>
            <Button variant="ghost" size="sm" className="text-primary" onClick={onEdit}>
              <PencilIcon />
              {t('edit')}
              <span className="sr-only">: {title}</span>
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <dl className="divide-y">
          {rows.map((row) => (
            <div
              key={row.label}
              className={cn(
                'grid gap-1 py-2.5',
                row.wide ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-[9rem_1fr] sm:gap-4',
              )}
            >
              <dt className="text-sm text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 break-words">
                {row.value === null || row.value === undefined || row.value === '' ? (
                  <span className="text-muted-foreground">{t('notRecorded')}</span>
                ) : (
                  row.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/** Status history, newest first (docs/28 §4): from → to, reason, who and when. */
export function StatusHistory({
  kind,
  entries,
}: {
  kind: PeopleKind;
  entries: StatusHistoryEntry[];
}) {
  const t = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  return (
    <Card className="gap-2 shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('history.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="py-2 text-muted-foreground">{t('history.empty')}</p>
        ) : (
          <ol className="divide-y">
            {entries.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-semibold">
                  {entry.from
                    ? t('history.change', {
                        from: statusLabel(kind, entry.from, locale),
                        to: statusLabel(kind, entry.to, locale),
                      })
                    : statusLabel(kind, entry.to, locale)}
                </span>
                {entry.reason && (
                  <span>
                    {t('history.reason')}: {entry.reason}
                  </span>
                )}
                <span className="text-sm text-muted-foreground">
                  {[entry.by?.name, formatInstant(entry.at, me.timezone, locale)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Archived = read-only (D128): a banner with when, who and why, and «استعادة» when allowed. */
export function ArchivedBanner({
  archive,
  action,
}: {
  archive: NonNullable<ArchiveInfo>;
  action?: ReactNode;
}) {
  const t = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  return (
    <Alert>
      <ArchiveIcon />
      <AlertTitle>{t('archive.bannerTitle')}</AlertTitle>
      <AlertDescription>
        <p>
          {t('archive.banner', {
            date: formatInstant(archive.archivedAt, me.timezone, locale) ?? '',
            name: archive.by?.name ?? '—',
          })}
        </p>
        {archive.reason && (
          <p>
            {t('history.reason')}: {archive.reason}
          </p>
        )}
        {action && <div className="mt-2">{action}</div>}
      </AlertDescription>
    </Alert>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
