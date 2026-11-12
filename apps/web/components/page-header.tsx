'use client';

import { Button } from '@qarabic/ui/components/button';
import { ArrowRightIcon, Maximize2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';
import { useRecordPane } from '@/components/list/split-view';

/**
 * Page title (one h1 per page) + optional description and count, with the page's actions at the
 * inline-end (docs/15 §5.2, F10: «أضف …» lives on the list page header). Detail pages pass `back`
 * for the arrow before the title, as in the current app.
 * Inside the split view's detail pane (D141 §1) the title is an h2, «إغلاق» replaces the back
 * arrow and «فتح في صفحة كاملة» joins the actions; record views need no change for this.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  back,
  leading,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };
  /** Shown between the back arrow and the title (e.g. the avatar). */
  leading?: ReactNode;
}) {
  const t = useTranslations('list.split');
  const pane = useRecordPane();
  const Heading = pane ? 'h2' : 'h1';
  return (
    // From `sm` the actions sit beside the title and wrap below it when they don't fit; the title
    // keeps at least 16rem so wide actions (search + filters) never squeeze it to one letter.
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3 sm:shrink-0 sm:grow sm:basis-64">
        {pane ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="mt-0.5 shrink-0"
            aria-label={t('close')}
            onClick={pane.onClose}
          >
            <XIcon />
          </Button>
        ) : (
          back && (
            <Button variant="ghost" size="icon-lg" asChild className="mt-0.5 shrink-0">
              <Link href={back.href} aria-label={back.label} onClick={back.onClick}>
                <ArrowRightIcon className="ltr:rotate-180" />
              </Link>
            </Button>
          )
        )}
        {leading}
        <div className="flex min-w-0 flex-col gap-1">
          <Heading className="text-2xl font-bold tracking-normal break-words">{title}</Heading>
          {description && <div className="text-muted-foreground">{description}</div>}
          {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
        </div>
      </div>
      {(actions || pane) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {actions}
          {pane && (
            <Button variant="ghost" size="icon" asChild>
              <Link href={pane.fullHref} aria-label={t('openFull')} title={t('openFull')}>
                <Maximize2Icon />
              </Link>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
