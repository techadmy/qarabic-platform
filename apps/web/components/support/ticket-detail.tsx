'use client';

import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_CHANNEL_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_QUEUE_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  TICKET_UPLOAD_LIMITS,
  updateTicketSchema,
  type PersonRef,
  type TicketAttachmentDto,
  type TicketCategory,
  type TicketCommentDto,
  type TicketDetailDto,
  type TicketPriority,
  type TicketStatus,
  type UpdateTicketInput,
} from '@qarabic/shared';
import { Alert, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { Label } from '@qarabic/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { cn } from '@qarabic/ui/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheckIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  ImageIcon,
  ImageOffIcon,
  PaperclipIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { InfoSection } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { SessionSheet, useOpenSession } from '@/components/sessions/session-sheet';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  addTicketComment,
  attachmentSrc,
  confirmTicket,
  fetchQueueAssignees,
  fetchTicket,
  fetchTriagers,
  markTicketSeen,
  supportKeys,
  updateTicket,
} from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import { dayAndClock } from '@/lib/schedule-time';
import { useSupportError } from '@/lib/support/errors';
import { topicLabel } from '@/lib/support/labels';
import { PriorityBadge, QueueBadge, RestrictedBadge, SlaBadge, TicketStatusBadge } from './badges';
import { StatusDialog } from './status-dialog';

const MAX_FILES = TICKET_UPLOAD_LIMITS.maxImagesPerRequest;
const TYPES: readonly string[] = TICKET_UPLOAD_LIMITS.imageMimes;

function Section({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <Card className="gap-3 shadow-none" aria-labelledby={id}>
      <CardHeader className="border-b">
        <CardTitle id={id} className="text-base font-bold">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

/** Images of a ticket or a comment: thumbnails that open the private file in a new tab. */
function Attachments({ items }: { items: TicketAttachmentDto[] }) {
  const t = useTranslations('support.ticket');
  return (
    <ul className="flex flex-wrap gap-3">
      {items.map((a, i) => (
        <li key={a.id}>
          {a.available && a.url ? (
            <a
              href={attachmentSrc(a.url)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('openImage', { n: i + 1 })}
              className="block overflow-hidden rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a private API file */}
              <img src={attachmentSrc(a.url)} alt="" className="h-24 w-36 object-cover" />
            </a>
          ) : (
            <span className="flex h-24 w-36 flex-col items-center justify-center gap-1 rounded-md border p-2 text-center text-xs text-muted-foreground">
              <ImageOffIcon aria-hidden className="size-5" />
              {t('imageUnavailable')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function TimelineItem({ row, ticket }: { row: TicketCommentDto; ticket: TicketDetailDto }) {
  const t = useTranslations('support.ticket');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const who =
    row.byReporter && ticket.isMine
      ? t('you')
      : (row.author?.name ?? row.authorLabel ?? t('system'));
  const meta = row.meta as { to?: string | null; toName?: string | null; field?: string };
  let headline: string | null = null;
  if (row.kind === 'status' && meta.to && meta.to in TICKET_STATUS_LABELS) {
    headline = t('statusChanged', { to: TICKET_STATUS_LABELS[meta.to as TicketStatus][locale] });
  } else if (row.kind === 'priority') {
    headline = t('priorityChanged', {
      to:
        meta.to && meta.to in TICKET_PRIORITY_LABELS
          ? TICKET_PRIORITY_LABELS[meta.to as TicketPriority][locale]
          : '—',
    });
  } else if (row.kind === 'assignment') {
    headline = meta.toName ? t('assigned', { name: meta.toName }) : t('unassigned');
  } else if (row.kind === 'system') {
    headline = t('changed');
  }
  return (
    <li
      className={cn(
        'flex flex-col gap-1 rounded-md border p-3',
        row.internal
          ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
          : row.byReporter
            ? 'bg-muted/50'
            : 'bg-card',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{who}</span>
        <span className="text-muted-foreground">
          <bdi>{dayAndClock(row.createdAt, tz, locale)}</bdi>
        </span>
        {row.internal && (
          <span className="rounded-sm border border-amber-300 px-1.5 text-xs font-medium text-amber-900 dark:text-amber-300">
            {t('internalTag')}
          </span>
        )}
      </div>
      {headline && <p className="text-sm font-medium">{headline}</p>}
      {row.body && <p className="text-sm break-words whitespace-pre-wrap">{row.body}</p>}
      {row.attachments.length > 0 && <Attachments items={row.attachments} />}
    </li>
  );
}

/**
 * The reply box: images (≤ 3), an internal note for managers, Ctrl/⌘ + Enter sends. The button
 * stays enabled and says what is missing instead of greying out (docs/15 §5).
 */
function Composer({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('support.ticket');
  const tr = useTranslations('support.report');
  const queryClient = useQueryClient();
  const message = useSupportError();
  const id = useId();
  const internalId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [internal, setInternal] = useState(false);
  const add = useMutation({
    mutationFn: () =>
      addTicketComment(
        ticket.id,
        { body: body.trim(), internal: ticket.can.commentInternal && internal },
        files,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(internal ? t('noteSaved') : t('sent'));
      setBody('');
      setFiles([]);
      setMissing(false);
    },
  });

  function pick(list: FileList | null) {
    setFileError(null);
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (!TYPES.includes(f.type)) {
        setFileError(tr('imageType', { name: f.name }));
        continue;
      }
      if (f.size > TICKET_UPLOAD_LIMITS.maxImageBytes) {
        setFileError(tr('imageTooBig', { name: f.name }));
        continue;
      }
      if (next.length >= MAX_FILES) {
        setFileError(tr('tooMany'));
        break;
      }
      next.push(f);
    }
    setFiles(next);
  }

  function send() {
    if (add.isPending) return;
    if (!body.trim()) {
      setMissing(true);
      return;
    }
    add.mutate();
  }

  return (
    <FieldGroup className="gap-3">
      <Field data-invalid={missing}>
        <FieldLabel htmlFor={id}>{ticket.can.manage ? t('replyStaff') : t('reply')}</FieldLabel>
        <Textarea
          id={id}
          rows={3}
          maxLength={5000}
          value={body}
          placeholder={t('replyPlaceholder')}
          aria-invalid={missing}
          onChange={(e) => {
            setBody(e.target.value);
            if (e.target.value.trim()) setMissing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {missing ? (
          <FieldError>{t('replyRequired')}</FieldError>
        ) : (
          <FieldDescription>{t('sendHint')}</FieldDescription>
        )}
      </Field>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
            >
              <ImageIcon aria-hidden className="size-4" />
              <bdi>{f.name}</bdi>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={tr('removeImage', { name: f.name })}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {fileError && <FieldError>{fileError}</FieldError>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {files.length < MAX_FILES && (
            <Button type="button" variant="ghost" onClick={() => fileRef.current?.click()}>
              <PaperclipIcon />
              {t('attach')}
            </Button>
          )}
          <span className="text-sm text-muted-foreground">{t('attachHelp')}</span>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept={TYPES.join(',')}
            data-testid="reply-file-input"
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {ticket.can.commentInternal && (
            <div className="flex items-center gap-2">
              <Checkbox
                id={internalId}
                checked={internal}
                onCheckedChange={(v) => setInternal(v === true)}
              />
              <Label htmlFor={internalId} className="font-normal">
                {t('internal')}
              </Label>
            </div>
          )}
          <Button type="button" onClick={send} aria-busy={add.isPending}>
            {add.isPending && <Spinner />}
            {t('send')}
          </Button>
        </div>
      </div>
      {add.isError && (
        <Alert variant="destructive">
          <AlertDescription>{message(add.error)}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}

/** «هل حُلّت المشكلة؟» on a fixed ticket (the reporter): resolved → closed; not → reopened. */
function ConfirmFix({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('support.ticket');
  const queryClient = useQueryClient();
  const message = useSupportError();
  const [why, setWhy] = useState(false);
  const confirm = useMutation({
    mutationFn: (v: { resolved: boolean; body?: string }) => confirmTicket(ticket.id, v),
    onSuccess: (detail, v) => {
      queryClient.setQueryData(supportKeys.ticket(ticket.id), detail);
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      setWhy(false);
      if (v.resolved) toast.success(t('thanks'));
      else toast.info(t('reopened'));
    },
    onError: (e) => toast.error(message(e)),
  });
  return (
    <Alert className="border-teal-300 bg-teal-50 dark:border-teal-900 dark:bg-teal-950">
      <CircleCheckIcon />
      <AlertTitle className="font-bold">{t('confirmTitle')}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>{ticket.resolution ?? t('confirmBody')}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={confirm.isPending} onClick={() => confirm.mutate({ resolved: true })}>
            {t('resolved')}
          </Button>
          <Button variant="outline" disabled={confirm.isPending} onClick={() => setWhy(true)}>
            {t('notResolved')}
          </Button>
        </div>
      </AlertDescription>
      <ReasonDialog
        open={why}
        onOpenChange={setWhy}
        title={t('notResolvedTitle')}
        description={t('notResolvedDescription')}
        confirmLabel={t('reopen')}
        textLabel={t('notResolvedLabel')}
        textRequired
        busy={confirm.isPending}
        error={confirm.isError ? message(confirm.error) : null}
        onConfirm={(v) => confirm.mutate({ resolved: false, body: v.text })}
      />
    </Alert>
  );
}

/** What the requester sees beside the conversation: who handles it and when it last moved. */
function ReporterPanel({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('support.ticket');
  const locale = useUiLocale();
  const tz = useViewerTz();
  return (
    <InfoSection
      title={t('about')}
      rows={[
        { label: t('handledBy'), value: ticket.handledBy ?? t('notAssigned') },
        { label: t('sentAt'), value: <bdi>{dayAndClock(ticket.createdAt, tz, locale)}</bdi> },
        {
          label: t('lastUpdate'),
          value: <bdi>{dayAndClock(ticket.lastPublicAt ?? ticket.createdAt, tz, locale)}</bdi>,
        },
      ]}
    />
  );
}

function FieldSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="h-10! w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

const NONE = 'none';

/**
 * Triage beside the ticket (`feedback.manage`, or `support.handle` in its queue): move the status
 * (the lifecycle dialog), priority, topic, assignee (members of the ticket's queue), area, the PR
 * link and the resolution note shown to the requester.
 */
function TriagePanel({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('support.triage');
  const tt = useTranslations('support.ticket');
  const ts = useTranslations('support');
  const ti = useTranslations('support.inbox');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const areaId = useId();
  const prId = useId();
  const resId = useId();
  const [moving, setMoving] = useState(false);
  const [area, setArea] = useState(ticket.area ?? '');
  const [pr, setPr] = useState(ticket.prUrl ?? '');
  const [resolution, setResolution] = useState(ticket.resolution ?? '');
  const [touched, setTouched] = useState(false);
  const inQueue = can(me, 'support.handle') || can(me, 'support.manage');
  const assignees = useQuery({
    queryKey: inQueue ? supportKeys.assignees(ticket.queue) : supportKeys.triagers,
    queryFn: ({ signal }): Promise<PersonRef[]> =>
      inQueue ? fetchQueueAssignees(ticket.queue, signal) : fetchTriagers(signal),
  });
  const patch = useMutation({
    mutationFn: (body: UpdateTicketInput) => updateTicket(ticket.id, body),
    onSuccess: (detail) => {
      queryClient.setQueryData(supportKeys.ticket(ticket.id), detail);
      void queryClient.invalidateQueries({ queryKey: supportKeys.all });
      toast.success(t('saved'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const prOk = !pr.trim() || updateTicketSchema.shape.prUrl.safeParse(pr.trim()).success;
  const areaOk = !area.trim() || /^[a-z0-9_-]{1,40}$/.test(area.trim());
  const people = assignees.data ?? [];
  const current = ticket.assignee;

  return (
    <Card className="gap-3 shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base font-bold">{t('panel')}</CardTitle>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          {ticket.can.nextStatuses.length > 0 && (
            <Button onClick={() => setMoving(true)}>{ti('status')}</Button>
          )}
          <FieldSelect
            label={t('priority')}
            value={ticket.priority ?? NONE}
            disabled={patch.isPending}
            onChange={(v) => patch.mutate({ priority: v === NONE ? null : (v as TicketPriority) })}
            options={[
              { value: NONE, label: ts('priorityNone') },
              ...TICKET_PRIORITIES.map((p) => ({
                value: p,
                label: TICKET_PRIORITY_LABELS[p][locale],
              })),
            ]}
          />
          <FieldSelect
            label={t('category')}
            value={ticket.category}
            disabled={patch.isPending}
            onChange={(v) => patch.mutate({ category: v as TicketCategory })}
            options={TICKET_CATEGORIES.map((c) => ({
              value: c,
              label: TICKET_CATEGORY_LABELS[c][locale],
            }))}
          />
          <FieldSelect
            label={t('assignee')}
            value={current ? String(current.id) : NONE}
            disabled={patch.isPending}
            onChange={(v) => patch.mutate({ assigneeId: v === NONE ? null : Number(v) })}
            options={[
              { value: NONE, label: t('unassigned') },
              ...(current && !people.some((p) => p.id === current.id)
                ? [{ value: String(current.id), label: current.name ?? `#${current.id}` }]
                : []),
              ...people.map((p) => ({ value: String(p.id), label: p.name })),
            ]}
          />
          <Field data-invalid={touched && !areaOk}>
            <FieldLabel htmlFor={areaId}>{t('area')}</FieldLabel>
            <Input
              id={areaId}
              dir="ltr"
              maxLength={40}
              value={area}
              onChange={(e) => setArea(e.target.value.toLowerCase())}
            />
          </Field>
          <Field data-invalid={touched && !prOk}>
            <FieldLabel htmlFor={prId}>{tt('pr')}</FieldLabel>
            <Input
              id={prId}
              dir="ltr"
              value={pr}
              placeholder={t('prHelp')}
              aria-invalid={touched && !prOk}
              onChange={(e) => setPr(e.target.value)}
            />
            {touched && !prOk && <FieldError>{t('prInvalid')}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor={resId}>{t('resolution')}</FieldLabel>
            <Textarea
              id={resId}
              rows={2}
              maxLength={2000}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </Field>
          <Button
            variant="outline"
            disabled={patch.isPending}
            onClick={() => {
              setTouched(true);
              if (!prOk || !areaOk) return;
              patch.mutate({
                area: area.trim() || null,
                prUrl: pr.trim() || null,
                resolution: resolution.trim() || null,
              });
            }}
          >
            {t('save')}
          </Button>
        </FieldGroup>
      </CardContent>
      <StatusDialog ticket={ticket} open={moving} onOpenChange={setMoving} />
    </Card>
  );
}

/**
 * One request (docs/22 §10, docs/32 §6.3): the requester sees the status, who handles it, the
 * timeline with the public replies, the reply box and «هل حُلّت المشكلة؟»; managers also see
 * internal notes, the technical details and the triage panel. Opening it clears the «طلباتي» dot.
 */
export function TicketDetailView({ id }: { id: number }) {
  const t = useTranslations('support.ticket');
  const ts = useTranslations('support');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const { open: openSession } = useOpenSession();
  const query = useQuery({
    queryKey: supportKeys.ticket(id),
    queryFn: ({ signal }) => fetchTicket(id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const ticket = query.data;
  const seen = useMutation({
    mutationFn: (ticketId: number) => markTicketSeen(ticketId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: supportKeys.all }),
  });
  const { mutate: markSeen } = seen;
  useEffect(() => {
    if (ticket?.isMine && ticket.hasUpdate) markSeen(ticket.id);
  }, [ticket?.id, ticket?.isMine, ticket?.hasUpdate, markSeen]);

  const back = ticket?.can.manage
    ? can(me, 'support.view')
      ? '/support'
      : '/feedback'
    : '/my-requests';

  if (query.isError || !(id > 0)) {
    const missing = !(id > 0) || isApiError(query.error, 404) || isApiError(query.error, 403);
    return (
      <>
        <PageHeader title={t('about')} back={{ href: '/my-requests', label: t('back') }} />
        {missing ? (
          <EmptyState
            icon={FileSearchIcon}
            role="status"
            title={t('notFound')}
            description={t('notFoundHint')}
          />
        ) : (
          <ErrorState onRetry={() => void query.refetch()} />
        )}
      </>
    );
  }
  if (!ticket) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-40" />
        <Skeleton className="h-60" />
      </div>
    );
  }

  const files = ticket.attachments.filter((a) => a.commentId === null);
  const ctx = ticket.context as Record<string, unknown>;
  const str = (k: string) => (typeof ctx[k] === 'string' ? (ctx[k] as string) : '');
  const errors = Array.isArray(ctx.recentErrors)
    ? (ctx.recentErrors as { method?: string; path?: string; status?: number }[])
    : null;
  const sessionId = ticket.subject?.type === 'session' ? ticket.subject.id : null;
  const subject = ticket.subject ? (
    ticket.subject.type === 'session' ? (
      <button
        type="button"
        className="font-medium text-primary hover:underline"
        onClick={() => openSession(sessionId!)}
      >
        {t('subjectSession', { when: `#${ticket.subject.id}` })}
      </button>
    ) : ticket.subject.type === 'student' ? (
      t('subjectStudent', { id: ticket.subject.id })
    ) : (
      t('subjectInvoice', { id: ticket.subject.id })
    )
  ) : null;

  return (
    <>
      <PageHeader
        back={{ href: back, label: t('back') }}
        title={
          <>
            <bdi>{ticket.number}</bdi> · {ticket.title}
          </>
        }
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <TicketStatusBadge status={ticket.status} />
            {ticket.can.manage && <PriorityBadge priority={ticket.priority} />}
            {ticket.can.manage && <QueueBadge queue={ticket.queue} />}
            {ticket.can.manage && ticket.visibility === 'restricted' && <RestrictedBadge />}
            {ticket.can.manage && <SlaBadge dueAt={ticket.slaDueAt} state={ticket.slaState} />}
            <span>{topicLabel(ticket, locale)}</span>
            <span>
              · <bdi>{dayAndClock(ticket.createdAt, tz, locale)}</bdi>
              {ticket.reporter && !ticket.isMine && <> · {ticket.reporter.name}</>}
              {' · '}
              {TICKET_CHANNEL_LABELS[ticket.channel][locale]}
            </span>
            {ticket.prUrl && (
              <a
                href={ticket.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLinkIcon aria-hidden className="size-4" />
                {t('openPr')}
              </a>
            )}
          </span>
        }
      />
      {ticket.can.confirm && <ConfirmFix ticket={ticket} />}
      {ticket.isMine &&
        (ticket.status === 'wont_fix' || ticket.status === 'verified') &&
        ticket.resolution && (
          <Alert>
            <AlertDescription>{ticket.resolution}</AlertDescription>
          </Alert>
        )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('description')} id="ticket-description">
            <p className="break-words whitespace-pre-wrap">{ticket.description}</p>
            {subject && (
              <p className="text-sm text-muted-foreground">
                {t('linked')}: {subject}
              </p>
            )}
            {files.length > 0 ? (
              <Attachments items={files} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('noAttachments')}</p>
            )}
          </Section>
          <Section title={t('timeline')} id="ticket-timeline">
            {ticket.timeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noTimeline')}</p>
            ) : (
              <ol aria-label={t('timeline')} className="flex flex-col gap-2">
                {ticket.timeline.map((row) => (
                  <TimelineItem key={row.id} row={row} ticket={ticket} />
                ))}
              </ol>
            )}
            {ticket.can.comment ? (
              <Composer ticket={ticket} />
            ) : (
              ticket.isMine && <p className="text-sm text-muted-foreground">{t('closedNoReply')}</p>
            )}
          </Section>
          {ticket.can.manage && (
            <InfoSection
              title={t('context')}
              rows={[
                {
                  label: ts('report.detail.page'),
                  value: <bdi dir="ltr">{str('pageUrl') || '—'}</bdi>,
                },
                ...(subject ? [{ label: t('linked'), value: subject }] : []),
                { label: t('queue'), value: TICKET_QUEUE_LABELS[ticket.queue][locale] },
                { label: ts('report.type'), value: TICKET_TYPE_LABELS[ticket.type][locale] },
                {
                  label: ts('report.detail.version'),
                  value: <bdi dir="ltr">{str('appVersion') || '—'}</bdi>,
                },
                {
                  label: ts('report.detail.zone'),
                  value: (
                    <bdi dir="ltr">
                      {[str('displayZone'), str('timeZone')].filter(Boolean).join(' · ') || '—'}
                    </bdi>
                  ),
                },
                {
                  label: ts('report.detail.device'),
                  value: (
                    <bdi dir="ltr">
                      {[str('platform'), str('viewport')].filter(Boolean).join(' · ') || '—'}
                    </bdi>
                  ),
                },
                ...(str('userAgent')
                  ? [
                      {
                        label: 'User agent',
                        value: <bdi dir="ltr">{str('userAgent')}</bdi>,
                        wide: true,
                      },
                    ]
                  : []),
                ...(errors
                  ? [
                      {
                        label: ts('report.detail.errors'),
                        wide: true,
                        value: errors.length ? (
                          <pre dir="ltr" className="text-xs whitespace-pre-wrap">
                            {errors
                              .map((e) => `${e.method ?? ''} ${e.path ?? ''} ${e.status ?? ''}`)
                              .join('\n')}
                          </pre>
                        ) : (
                          ts('report.detail.errorsNone')
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
        <div className="flex flex-col gap-4">
          {ticket.can.manage ? (
            <TriagePanel
              key={`${ticket.prUrl ?? ''}|${ticket.resolution ?? ''}|${ticket.area ?? ''}`}
              ticket={ticket}
            />
          ) : (
            <ReporterPanel ticket={ticket} />
          )}
        </div>
      </div>
      {sessionId && <SessionSheet />}
    </>
  );
}
