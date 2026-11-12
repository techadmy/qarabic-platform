'use client';

import type { MyRequestItemDto } from '@qarabic/shared';
import { Card } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { InboxIcon, SearchXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { RequestCard } from '@/app/(app)/requests/requests-view';
import { ListPagination } from '@/components/list/list-pagination';
import { StatusTabs } from '@/components/list/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { SessionSheet } from '@/components/sessions/session-sheet';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import { fetchMine, supportKeys } from '@/lib/api/support';
import { useListParams } from '@/lib/list-params';
import { dayAndClock } from '@/lib/schedule-time';
import { hasMyRequests, topicLabel } from '@/lib/support/labels';
import { TicketStatusBadge, UpdateDot } from './badges';

const TABS = ['open', 'closed', 'any'] as const;
type Tab = (typeof TABS)[number];

/** Every row ends with what happens next and, for a ticket, by when the team replies (D30). */
function NextStep({ item }: { item: MyRequestItemDto }) {
  const t = useTranslations('support.mine');
  const locale = useUiLocale();
  const tz = useViewerTz();
  if (!item.nextStep) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span
        className={cn(
          'font-semibold',
          item.nextStep === 'reply_needed' || item.nextStep === 'confirm_fix'
            ? 'text-status-orange-emphasis'
            : undefined,
        )}
      >
        {t('next')}: {t(`nextStep.${item.nextStep}`)}
      </span>
      {item.slaDueAt && item.nextStep === 'awaiting_team' && (
        <span className="text-muted-foreground">
          {t('replyBy', { time: dayAndClock(item.slaDueAt, tz, locale) })}
        </span>
      )}
    </p>
  );
}

function TicketRow({ item }: { item: MyRequestItemDto }) {
  const t = useTranslations('support.mine');
  const locale = useUiLocale();
  const ticket = item.ticket!;
  return (
    <Card
      className="gap-2 px-4 py-3 shadow-none"
      aria-label={`${ticket.number} · ${item.title ?? ticket.title}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/tickets/${item.id}`}
          className="text-base font-bold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        >
          <bdi>{ticket.number}</bdi> · {item.title ?? ticket.title}
        </Link>
        <span className="flex flex-wrap items-center gap-2">
          {item.hasUpdate && <UpdateDot label={t('updated')} />}
          <TicketStatusBadge status={ticket.status} />
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('kind.ticket')} · {topicLabel(ticket, locale)}
      </p>
      <NextStep item={item} />
    </Card>
  );
}

/**
 * «طلباتي» (docs/32 §2, S2) for parents, teachers and staff: support requests and class requests
 * in one list, open first, each with its status and the next step. A ticket with news carries a
 * dot until it is opened; a class request keeps «سحب الطلب».
 */
export function MyRequestsView() {
  const t = useTranslations('support');
  const me = useCurrentUser();
  const params = useListParams();
  const raw = params.get('status') as Tab;
  const tab: Tab = TABS.includes(raw) ? raw : 'open';
  const allowed = hasMyRequests(me);
  const query = {
    status: tab === 'any' ? undefined : tab,
    page: params.page,
    perPage: params.perPage,
  };
  const list = useQuery({
    queryKey: supportKeys.mine(query),
    queryFn: ({ signal }) => fetchMine(query, signal),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('mine.title')} />
        <ForbiddenState />
      </>
    );
  }
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <PageHeader
        title={t('mine.title')}
        description={t('mine.subtitle')}
        meta={meta ? t('mine.openCount', { count: meta.open }) : undefined}
      />
      <Card className="gap-0 py-0 shadow-none">
        <div className="-mx-1 overflow-x-auto border-b p-4">
          <StatusTabs
            label={t('mine.tabs')}
            value={tab === 'open' ? '' : tab}
            onChange={(v) => params.set({ status: v || null })}
            options={TABS.map((k) => ({
              value: k === 'open' ? '' : k,
              label: t(`status.${k === 'any' ? 'all' : k}`),
              count: k === 'open' ? meta?.open : undefined,
            }))}
          />
        </div>
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            {tab === 'open' && meta?.total === 0 && meta.open === 0 ? (
              <EmptyState
                icon={InboxIcon}
                title={t('mine.empty')}
                description={t('mine.emptyHint')}
              />
            ) : (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={t('mine.emptyTab')}
                description={t('mine.emptyTabHint')}
              />
            )}
          </div>
        ) : (
          <ul aria-label={t('mine.title')} className="flex flex-col gap-3 p-3 sm:p-4">
            {rows.map((item) => (
              <li key={item.key}>
                {item.kind === 'session_request' && item.request ? (
                  <RequestCard request={item.request} extra={<NextStep item={item} />} />
                ) : item.ticket ? (
                  <TicketRow item={item} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {meta && rows.length > 0 && (
          <ListPagination
            meta={{ ...meta, counts: {} }}
            onPage={(page) => params.set({ page: page === 1 ? null : page }, { resetPage: false })}
            onPerPage={(perPage) => params.set({ perPage: perPage === 25 ? null : perPage })}
          />
        )}
      </Card>
      <SessionSheet />
    </div>
  );
}
