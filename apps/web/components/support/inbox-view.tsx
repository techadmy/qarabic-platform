'use client';

import {
  FAMILY_STATUS_LABELS,
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_CHANNEL_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_QUEUE_LABELS,
  TICKET_QUEUES,
  type InboxItemDto,
  type InboxQuery,
  type TicketDto,
  type TicketQueue,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Field, FieldError, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@qarabic/ui/components/sheet';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Switch } from '@qarabic/ui/components/switch';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InboxIcon, SearchXIcon, UserRoundSearchIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RequestCard } from '@/app/(app)/requests/requests-view';
import { ListPagination } from '@/components/list/list-pagination';
import {
  ClearFiltersButton,
  FilterSelect,
  ListToolbar,
  StatusTabs,
} from '@/components/list/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { SessionSheet } from '@/components/sessions/session-sheet';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  addTicketComment,
  fetchInbox,
  fetchQueueAssignees,
  fetchSupportPeople,
  supportKeys,
  takeTicket,
  updateTicket,
} from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { useDirection } from '@/lib/use-direction';
import { useListParams } from '@/lib/list-params';
import { dayAndClock } from '@/lib/schedule-time';
import { useSupportError } from '@/lib/support/errors';
import { topicLabel } from '@/lib/support/labels';
import { cityOf } from '@/lib/time';
import { PriorityBadge, QueueBadge, RestrictedBadge, SlaBadge, TicketStatusBadge } from './badges';
import { StatusDialog } from './status-dialog';

type PanelTarget = { familyId?: number; teacherId?: number; name: string };

const STATUS_FILTERS = ['open', 'closed', 'all'] as const;

/** Reply from the inbox (public, or an internal note). */
function ReplyDialog({
  ticket,
  open,
  onOpenChange,
}: {
  ticket: TicketDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('support.inbox');
  const tt = useTranslations('support.ticket');
  const tf = useTranslations('support.form');
  const queryClient = useQueryClient();
  const message = useSupportError();
  const textId = useId();
  const internalId = useId();
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [touched, setTouched] = useState(false);
  const reply = useMutation({
    mutationFn: () => addTicketComment(ticket.id, { body: text.trim(), internal }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(internal ? tt('noteSaved') : tt('sent'));
      change(false);
    },
  });
  function change(next: boolean) {
    if (!next) {
      setText('');
      setInternal(false);
      setTouched(false);
      reply.reset();
    }
    onOpenChange(next);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!text.trim()) return;
    reply.mutate();
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !reply.isPending && change(o)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('replyTitle', { number: ticket.number })}</DialogTitle>
            <DialogDescription>{ticket.title}</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={touched && !text.trim()}>
              <FieldLabel htmlFor={textId}>{t('replyLabel')}</FieldLabel>
              <Textarea
                id={textId}
                rows={4}
                maxLength={5000}
                value={text}
                aria-invalid={touched && !text.trim()}
                onChange={(e) => setText(e.target.value)}
              />
              {touched && !text.trim() && <FieldError>{tt('replyRequired')}</FieldError>}
            </Field>
            <div className="flex items-center gap-2">
              <Checkbox
                id={internalId}
                checked={internal}
                onCheckedChange={(v) => setInternal(v === true)}
              />
              <Label htmlFor={internalId} className="font-normal">
                {tt('internal')}
              </Label>
            </div>
          </FieldGroup>
          {reply.isError && <p className="text-sm text-destructive">{message(reply.error)}</p>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={reply.isPending}>
                {tf('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={reply.isPending}>
              {reply.isPending && <Spinner />}
              {tt('send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The queue, the SLA timer and who it is about (opens the side panel), under every row. */
function RowMeta({ item, onPanel }: { item: InboxItemDto; onPanel: (p: PanelTarget) => void }) {
  const t = useTranslations('support.inbox');
  const name = item.family?.name ?? item.teacher?.name ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <QueueBadge queue={item.queue} />
      <SlaBadge dueAt={item.slaDueAt} state={item.slaState} />
      {name && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8"
          aria-label={t('showPanel', { name })}
          onClick={() => onPanel({ familyId: item.family?.id, teacherId: item.teacher?.id, name })}
        >
          <UserRoundSearchIcon />
          {name}
        </Button>
      )}
    </div>
  );
}

function TicketRow({
  item,
  ticket,
  onPanel,
}: {
  item: InboxItemDto;
  ticket: TicketDto;
  onPanel: (p: PanelTarget) => void;
}) {
  const t = useTranslations('support.inbox');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const dir = useDirection();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const [replying, setReplying] = useState(false);
  const [moving, setMoving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const handle = can(me, 'support.handle') || can(me, 'support.manage');
  const members = useQuery({
    queryKey: supportKeys.assignees(item.queue),
    queryFn: ({ signal }) => fetchQueueAssignees(item.queue, signal),
    enabled: assignOpen,
  });
  const done = (text: string) => () => {
    void queryClient.invalidateQueries({ queryKey: supportKeys.all });
    toast.success(text);
  };
  const take = useMutation({
    mutationFn: () => takeTicket(ticket.id),
    onSuccess: done(t('taken')),
    onError: (e) => toast.error(message(e)),
  });
  const assign = useMutation({
    mutationFn: (assigneeId: number) => updateTicket(ticket.id, { assigneeId }),
    onSuccess: done(t('assigned')),
    onError: (e) => toast.error(message(e)),
  });
  const mine = ticket.assignee?.id === me.id;
  const breached = item.slaState === 'breached';

  return (
    <Card
      aria-label={`${ticket.number} — ${ticket.title}`}
      className={cn(
        'flex-col gap-3 px-4 py-3 shadow-none md:flex-row md:items-start md:justify-between',
        breached && 'border-s-4 border-s-red-600',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/tickets/${ticket.id}`}
            className="font-bold text-primary hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <bdi>{ticket.number}</bdi> · {ticket.title}
          </Link>
          {ticket.visibility === 'restricted' && <RestrictedBadge />}
        </div>
        <p className="text-sm">{topicLabel(ticket, locale)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <TicketStatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <span className="text-sm text-muted-foreground">
            {ticket.reporter?.name ?? '—'} · {TICKET_CHANNEL_LABELS[ticket.channel][locale]} ·{' '}
            <bdi>{dayAndClock(ticket.createdAt, tz, locale)}</bdi>
          </span>
        </div>
        <RowMeta item={item} onPanel={onPanel} />
      </div>
      <div className="flex shrink-0 flex-col gap-2 md:items-end">
        <span className="text-sm text-muted-foreground">
          {ticket.assignee?.name
            ? t('handledBy', { name: ticket.assignee.name })
            : t('unassignedLabel')}
        </span>
        {handle && (
          <div className="flex flex-wrap gap-2">
            {!mine && (
              <Button size="sm" disabled={take.isPending} onClick={() => take.mutate()}>
                {t('take')}
                <span className="sr-only">: {ticket.number}</span>
              </Button>
            )}
            <DropdownMenu dir={dir} open={assignOpen} onOpenChange={setAssignOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={assign.isPending}>
                  {t('assign')}
                  <span className="sr-only">: {ticket.number}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  {t('assignTo')}
                </DropdownMenuLabel>
                {members.isPending ? (
                  <DropdownMenuItem disabled>
                    <Spinner />
                  </DropdownMenuItem>
                ) : (
                  (members.data ?? []).map((m) => (
                    <DropdownMenuItem
                      key={m.id}
                      disabled={ticket.assignee?.id === m.id}
                      onSelect={() => assign.mutate(m.id)}
                    >
                      {m.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" onClick={() => setReplying(true)}>
              {t('reply')}
              <span className="sr-only">: {ticket.number}</span>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
              {t('status')}
              <span className="sr-only">: {ticket.number}</span>
            </Button>
          </div>
        )}
      </div>
      {replying && <ReplyDialog ticket={ticket} open onOpenChange={setReplying} />}
      {moving && <StatusDialog ticket={ticket} open onOpenChange={setMoving} />}
    </Card>
  );
}

/** Who the request is about (docs/32 §6.4): the family and the teacher, without leaving the inbox. */
function PeoplePanel({
  target,
  onClose,
  onFilterFamily,
}: {
  target: PanelTarget | null;
  onClose: () => void;
  onFilterFamily: (familyId: number) => void;
}) {
  const t = useTranslations('support.inbox');
  const locale = useUiLocale();
  const dir = useDirection();
  const me = useCurrentUser();
  const query = { familyId: target?.familyId, teacherId: target?.teacherId };
  const people = useQuery({
    queryKey: supportKeys.people(query),
    queryFn: ({ signal }) => fetchSupportPeople(query, signal),
    enabled: !!target,
  });
  const data = people.data;
  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side={dir === 'rtl' ? 'left' : 'right'} className="w-full gap-0 sm:max-w-sm">
        <SheetHeader className="border-b">
          <SheetTitle>{t('panel')}</SheetTitle>
          <SheetDescription>{target?.name}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 p-4">
          {people.isPending ? (
            <Skeleton className="h-40" />
          ) : people.isError ? (
            <ErrorState onRetry={() => void people.refetch()} />
          ) : !data?.family && !data?.teacher ? (
            <p className="text-muted-foreground">{t('noPanel')}</p>
          ) : (
            <>
              {data.family && (
                <section className="flex flex-col gap-2" aria-label={t('family')}>
                  <h3 className="font-bold">
                    {t('family')}: {data.family.name}
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t('familyStatus')}</dt>
                    <dd>
                      {data.family.status && data.family.status in FAMILY_STATUS_LABELS
                        ? FAMILY_STATUS_LABELS[
                            data.family.status as keyof typeof FAMILY_STATUS_LABELS
                          ][locale]
                        : (data.family.status ?? '—')}
                    </dd>
                    <dt className="text-muted-foreground">{t('zone')}</dt>
                    <dd>{data.family.timezone ? cityOf(data.family.timezone, locale) : '—'}</dd>
                    <dt className="text-muted-foreground">{t('children')}</dt>
                    <dd>{data.family.children.map((c) => c.name).join('، ') || '—'}</dd>
                  </dl>
                  <p className="text-sm">{t('openTickets', { count: data.family.openTickets })}</p>
                  <p className="text-sm">
                    {t('pendingRequests', { count: data.family.pendingRequests })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => onFilterFamily(data.family!.id)}>
                      {t('filterFamily')}
                    </Button>
                    {can(me, 'families.view') && (
                      <Button variant="ghost" asChild>
                        <Link href={`/families/${data.family.id}`}>{t('openFamily')}</Link>
                      </Button>
                    )}
                  </div>
                </section>
              )}
              {data.teacher && (
                <section className="flex flex-col gap-2" aria-label={t('teacher')}>
                  <h3 className="font-bold">
                    {t('teacher')}: {data.teacher.name}
                  </h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t('zone')}</dt>
                    <dd>{cityOf(data.teacher.timezone, locale)}</dd>
                  </dl>
                </section>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * «صندوق الطلبات» (docs/32 §6.4, S2): one tab per queue the user belongs to with its open and
 * overdue counts, the SLA timer on every row (overdue first), filters in the URL, take / assign
 * within the queue, reply and status inline, and the pending class requests under «الجدولة» with
 * the same approve / reject card as «طلبات الحصص». A side panel shows the family and teacher.
 */
export function InboxView() {
  const t = useTranslations('support.inbox');
  const ts = useTranslations('support');
  const tl = useTranslations('list');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const params = useListParams();
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  const allowed = can(me, 'support.view');
  const queueParam = params.get('queue') as TicketQueue;
  const status = (STATUS_FILTERS as readonly string[]).includes(params.get('status'))
    ? (params.get('status') as InboxQuery['status'])
    : 'open';
  const kind = params.get('kind');
  const category = params.get('category');
  const priority = params.get('priority');
  const assignee = params.get('assignee');
  const breached = params.get('breached') === '1';
  const familyId = Number(params.get('family')) || undefined;
  const query: InboxQuery = {
    queue: TICKET_QUEUES.includes(queueParam) ? queueParam : undefined,
    status,
    kind: kind === 'ticket' || kind === 'session_request' ? kind : undefined,
    category: category || undefined,
    priority: priority || undefined,
    assignee: assignee === 'me' || assignee === 'none' ? assignee : undefined,
    breached: breached || undefined,
    familyId,
    q: params.q || undefined,
    page: params.page,
    perPage: params.perPage,
  } as InboxQuery;
  const list = useQuery({
    queryKey: supportKeys.inbox(query),
    queryFn: ({ signal }) => fetchInbox(query, signal),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    enabled: allowed,
  });
  if (!allowed || isApiError(list.error, 403)) {
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  }
  const meta = list.data?.meta;
  const rows = list.data?.data ?? [];
  const queues = meta?.queues ?? [];
  const filtered = !!(
    kind ||
    category ||
    priority ||
    assignee ||
    breached ||
    familyId ||
    params.q ||
    status !== 'open'
  );

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        meta={meta ? t('count', { count: meta.total }) : undefined}
      />
      <Card className="gap-0 py-0 shadow-none">
        <ListToolbar
          search={{
            label: t('search'),
            placeholder: t('searchPlaceholder'),
            value: params.searchInput,
            onChange: params.setSearchInput,
          }}
          filters={
            <>
              <FilterSelect
                label={t('filters.status')}
                value={status === 'open' ? '' : (status ?? '')}
                allLabel={ts('status.open')}
                onChange={(v) => params.set({ status: v || null })}
                options={[
                  { value: 'closed', label: ts('status.closed') },
                  { value: 'all', label: ts('status.all') },
                ]}
              />
              <FilterSelect
                label={t('filters.kind')}
                value={kind}
                allLabel={t('filters.any')}
                onChange={(v) => params.set({ kind: v || null })}
                options={(['ticket', 'session_request'] as const).map((k) => ({
                  value: k,
                  label: t(`kind.${k}`),
                }))}
              />
              <FilterSelect
                label={t('filters.category')}
                value={category}
                allLabel={t('filters.any')}
                onChange={(v) => params.set({ category: v || null })}
                options={TICKET_CATEGORIES.map((c) => ({
                  value: c,
                  label: TICKET_CATEGORY_LABELS[c][locale],
                }))}
              />
              <FilterSelect
                label={t('filters.priority')}
                value={priority}
                allLabel={t('filters.any')}
                onChange={(v) => params.set({ priority: v || null })}
                options={[
                  ...TICKET_PRIORITIES.map((p) => ({
                    value: p,
                    label: TICKET_PRIORITY_LABELS[p][locale],
                  })),
                  { value: 'none', label: ts('priorityNone') },
                ]}
              />
              <FilterSelect
                label={t('filters.assignee')}
                value={assignee}
                allLabel={t('filters.any')}
                onChange={(v) => params.set({ assignee: v || null })}
                options={[
                  { value: 'me', label: t('filters.mine') },
                  { value: 'none', label: t('filters.unassigned') },
                ]}
              />
              <BreachedSwitch
                checked={breached}
                onChange={(v) => params.set({ breached: v ? 1 : null })}
              />
              {familyId && (
                <Button
                  variant="outline"
                  className="h-10"
                  onClick={() => params.set({ family: null })}
                  aria-label={t('removeFamily')}
                >
                  {t('filters.family', { id: familyId })}
                  <XIcon />
                </Button>
              )}
              {filtered && (
                <ClearFiltersButton
                  onClick={() =>
                    params.clear(['kind', 'category', 'priority', 'assignee', 'breached', 'family'])
                  }
                />
              )}
            </>
          }
          tabs={
            <StatusTabs
              label={t('queues')}
              value={query.queue ?? ''}
              onChange={(v) => params.set({ queue: v || null })}
              options={[
                { value: '', label: t('allQueues'), count: undefined },
                ...queues.map((q) => {
                  const c = meta?.counts[q];
                  return {
                    value: q,
                    label:
                      `${TICKET_QUEUE_LABELS[q][locale]} (${c?.open ?? 0})` +
                      (c?.breached ? ` · ${t('breachedN', { count: c.breached })}` : ''),
                    count: undefined,
                  };
                }),
              ]}
            />
          }
        />
        {list.isError ? (
          <div className="p-4">
            <ErrorState onRetry={() => void list.refetch()} />
          </div>
        ) : list.isPending ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            {filtered ? (
              <EmptyState
                icon={SearchXIcon}
                role="status"
                title={tl('noResults')}
                description={tl('noResultsHint')}
              />
            ) : (
              <EmptyState icon={InboxIcon} title={t('empty')} description={t('emptyHint')} />
            )}
          </div>
        ) : (
          <ul aria-label={t('title')} className="flex flex-col gap-3 p-3 sm:p-4">
            {rows.map((item) => (
              <li key={item.key}>
                {item.kind === 'ticket' && item.ticket ? (
                  <TicketRow item={item} ticket={item.ticket} onPanel={setPanel} />
                ) : item.request ? (
                  <RequestCard
                    request={item.request}
                    extra={<RowMeta item={item} onPanel={setPanel} />}
                  />
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
      <PeoplePanel
        target={panel}
        onClose={() => setPanel(null)}
        onFilterFamily={(id) => {
          setPanel(null);
          params.set({ family: id });
        }}
      />
      <SessionSheet />
    </>
  );
}

function BreachedSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTranslations('support.inbox.filters');
  const id = useId();
  return (
    <div className="flex h-10 items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-medium">
        {t('breached')}
      </Label>
    </div>
  );
}
