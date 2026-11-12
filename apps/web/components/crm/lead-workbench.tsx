'use client';

import {
  CALL_RESULT_LABELS,
  CALL_RESULTS,
  HEARD_FROM_LABELS,
  LEAD_ACTIVITY_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  LOST_REASON_LABELS,
  LOST_REASONS,
  MANUAL_ACTIVITY_TYPES,
  PREFERRED_PERIOD_LABELS,
  SESSION_STAGE_LABELS,
  TEACHER_GENDER_PREF_LABELS,
  TRIAL_OUTCOME_LABELS,
  updateLeadSchema,
  type CallResult,
  type LeadActivityDto,
  type LeadDetailDto,
  type LeadStatus,
  type LostReason,
  type SessionStage,
  type UpdateLeadInput,
} from '@qarabic/shared';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@qarabic/ui/components/alert';
import { Badge } from '@qarabic/ui/components/badge';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Field, FieldError, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { cn } from '@qarabic/ui/lib/utils';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { Textarea } from '@qarabic/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@qarabic/ui/components/toggle-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangleIcon,
  CircleCheckIcon,
  MessageCircleIcon,
  MoreVerticalIcon,
  SearchXIcon,
  TimerIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useRef, useState } from 'react';
import { useForm, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { PageHeader } from '@/components/page-header';
import { InfoSection, KeyFacts, type InfoRow } from '@/components/people/detail';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { BothClassTimes, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  addLeadActivity,
  assignLead,
  changeLeadStatus,
  crmKeys,
  fetchLead,
  fetchLeadAssignees,
  updateLead,
} from '@/lib/api/crm';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { useListParams } from '@/lib/list-params';
import { dateKeyIn, relativeTime, weekdayName, zonedInstant } from '@/lib/schedule-time';
import { cityOf, formatInstant, formatTime } from '@/lib/time';
import { useDirection } from '@/lib/use-direction';
import { BookTrialDialog } from './book-trial-dialog';
import { ConvertDialog } from './convert-dialog';
import { LeadStatusBadge, primaryAction, useCrmError, type PrimaryAction } from './crm-bits';
import { LeadFields, toLeadBody, type LeadFormValues } from './lead-fields';
import { OutcomeDialog } from './outcome-dialog';
import { useRecordPane } from '@/components/list/split-view';

const TABS = ['activity', 'data', 'trials', 'family'] as const;
type TabKey = (typeof TABS)[number];
const OVERFLOW = [
  { action: 'lose', status: 'lost' },
  { action: 'spam', status: 'spam' },
  { action: 'job_applicant', status: 'job_applicant' },
  { action: 'reopen', status: 'reopen' },
] as const;
type Overflow = (typeof OVERFLOW)[number]['status'];
type DialogKey = 'trial' | 'outcome' | 'convert' | Overflow;

/** `/leads/:id` (docs/26 §9.3, K6 "profile = workbench"). */
export function LeadWorkbench({ id }: { id: number }) {
  const t = useTranslations('crm');
  const me = useCurrentUser();
  const allowed = me.permissions.includes('leads.view');
  const lead = useQuery({
    queryKey: crmKeys.lead(id),
    queryFn: ({ signal }) => fetchLead(id, signal),
    enabled: allowed,
  });
  if (!allowed || isApiError(lead.error, 403)) {
    return (
      <>
        <PageHeader title={t('work.title')} back={{ href: '/leads', label: t('work.back') }} />
        <ForbiddenState />
      </>
    );
  }
  if (isApiError(lead.error, 404)) {
    return (
      <>
        <PageHeader title={t('work.title')} back={{ href: '/leads', label: t('work.back') }} />
        <EmptyState
          icon={SearchXIcon}
          role="status"
          title={t('work.notFound')}
          description={t('work.notFoundHint')}
          action={
            <Button variant="outline" asChild>
              <Link href="/leads">{t('work.back')}</Link>
            </Button>
          }
        />
      </>
    );
  }
  if (lead.isError) return <ErrorState onRetry={() => void lead.refetch()} />;
  if (!lead.data) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-16" />
        <Skeleton className="h-20" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  return <Workbench lead={lead.data} />;
}

function Workbench({ lead }: { lead: LeadDetailDto }) {
  const t = useTranslations('crm');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const me = useCurrentUser();
  const dir = useDirection();
  const params = useListParams();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [dialog, setDialog] = useState<DialogKey | null>(null);
  const [lostPreset, setLostPreset] = useState('');
  const tabParam = params.get('tab') as TabKey;
  const tab: TabKey = TABS.includes(tabParam) ? tabParam : 'activity';
  const can = (a: LeadDetailDto['allowedActions'][number]) => lead.allowedActions.includes(a);
  const assignees = useQuery({
    queryKey: crmKeys.assignees,
    queryFn: ({ signal }) => fetchLeadAssignees(signal),
    enabled: can('assign'),
  });
  const setLead = (data: LeadDetailDto) => {
    queryClient.setQueryData(crmKeys.lead(lead.id), data);
    void queryClient.invalidateQueries({ queryKey: ['crm', 'leads'] });
    void queryClient.invalidateQueries({ queryKey: ['crm', 'summary'] });
  };
  const assign = useMutation({
    mutationFn: (userId: number | null) => assignLead(lead.id, { userId }),
    onSuccess: (data) => {
      setLead(data);
      toast.success(t('assigned'));
    },
    onError: (e) => toast.error(message(e)),
  });
  const status = useMutation({
    mutationFn: (v: { status: Overflow | 'contacted'; lostReason?: LostReason; note?: string }) =>
      changeLeadStatus(lead.id, v),
    onSuccess: setLead,
  });
  const primary = primaryAction(lead);
  const overflow = OVERFLOW.filter((o) => can(o.action));

  const onPrimary = (p: PrimaryAction) => {
    if (p === 'contact') {
      params.set({ tab: null }, { resetPage: false });
      setTimeout(() => composerRef.current?.focus(), 50);
    } else if (p === 'book_trial') setDialog('trial');
    else if (p === 'record_outcome') setDialog('outcome');
    else setDialog('convert');
  };

  const changeStatus = (s: Overflow, note: string, reason: string) =>
    status.mutate(
      {
        status: s,
        lostReason: s === 'lost' ? (reason as LostReason) : undefined,
        note: note || undefined,
      },
      {
        onSuccess: () => {
          setDialog(null);
          setLostPreset('');
          if (s === 'reopen') toast.success(t('confirm.done'));
          else
            toast.success(t('confirm.done'), {
              duration: 8000,
              action: {
                label: t('confirm.undo'),
                onClick: () =>
                  void changeLeadStatus(lead.id, { status: 'reopen' })
                    .then((d) => {
                      setLead(d);
                      toast.success(t('confirm.undone'));
                    })
                    .catch((e: unknown) => toast.error(message(e))),
              },
            });
        },
      },
    );

  const dup = lead.duplicates;
  const scheduledTrial = lead.trials.some((x) => x.stage === 'scheduled');
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(lead.createdAt)) / 86_400_000));
  const waLink = lead.phone ? `https://wa.me/${lead.phone.replace(/\D/g, '')}` : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={{ href: '/leads', label: t('work.back') }}
        title={lead.parentName}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LeadStatusBadge status={lead.status} />
            <span>{t('work.source', { source: LEAD_SOURCE_LABELS[lead.source][locale] })}</span>
            {lead.phone && (
              <>
                <span aria-hidden>·</span>
                <bdi dir="ltr">{lead.phone}</bdi>
              </>
            )}
            {lead.email && (
              <>
                <span aria-hidden>·</span>
                <bdi dir="ltr">{lead.email}</bdi>
              </>
            )}
            {lead.referralFamily && (
              <>
                <span aria-hidden>·</span>
                <span>{t('work.referredBy', { name: lead.referralFamily.name ?? '—' })}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <AssigneeControl
              lead={lead}
              canAssign={can('assign')}
              options={assignees.data ?? []}
              busy={assign.isPending}
              onAssign={(userId) => assign.mutate(userId)}
              selfId={me.id}
              canTake={can('assign_self')}
              canRelease={can('release')}
            />
            {waLink && (
              <Button variant="outline" asChild>
                <a href={waLink} target="_blank" rel="noreferrer">
                  <MessageCircleIcon />
                  {t('work.whatsapp')}
                </a>
              </Button>
            )}
            {primary && (
              <Button onClick={() => onPrimary(primary)}>{t(`primary.${primary}`)}</Button>
            )}
            {lead.status === 'trial_scheduled' && can('book_trial') && (
              <Button variant="outline" onClick={() => setDialog('trial')}>
                {t('actions.rebook')}
              </Button>
            )}
            {lead.status === 'trial_done' && can('book_trial') && (
              <Button variant="outline" onClick={() => setDialog('trial')}>
                {t('primary.book_trial')}
              </Button>
            )}
            {overflow.length > 0 && (
              <DropdownMenu dir={dir}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label={t('work.more')}>
                    <MoreVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {overflow.map((o) => (
                    <DropdownMenuItem
                      key={o.status}
                      variant={o.status === 'reopen' ? 'default' : 'destructive'}
                      onSelect={() => setDialog(o.status)}
                    >
                      {t(`actions.${o.status}`)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />

      {(dup.leads.length > 0 || dup.families.length > 0) && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangleIcon />
          <AlertTitle>{t('work.duplicateTitle')}</AlertTitle>
          <AlertDescription className="text-inherit">
            <ul className="list-inside list-disc">
              {dup.leads.map((d) => (
                <li key={`l${d.id}`}>
                  <Link href={`/leads/${d.id}`} className="font-semibold underline">
                    {t('work.duplicateLead', {
                      id: d.id,
                      status: LEAD_STATUS_LABELS[d.status as LeadStatus][locale],
                    })}
                  </Link>{' '}
                  {d.parentName}
                </li>
              ))}
              {dup.families.map((f) => (
                <li key={`f${f.id}`}>
                  <Link href={`/families/${f.id}`} className="font-semibold underline">
                    {t('work.duplicateFamily', { name: f.name ?? `#${f.id}` })}
                  </Link>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {lead.status === 'converted' && lead.convertedAt && (
        <Alert role="status">
          <CircleCheckIcon className="text-emerald-700" />
          <AlertDescription>
            {t('work.converted', {
              date: formatInstant(lead.convertedAt, tz, locale) ?? '',
              name: lead.convertedBy?.name ?? '—',
            })}
          </AlertDescription>
        </Alert>
      )}
      {lead.firstResponseOverdue && (
        <Alert variant="destructive">
          <TimerIcon />
          <AlertDescription>
            {t('work.overdue', {
              time: formatInstant(lead.firstResponseDueAt, tz, locale) ?? '',
            })}
          </AlertDescription>
        </Alert>
      )}
      {lead.suggestLostNoResponse && can('lose') && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangleIcon />
          <AlertDescription className="text-inherit">
            {t('work.suggestLost', { count: lead.unansweredAttempts })}
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLostPreset('no_response');
                setDialog('lost');
              }}
            >
              {t('work.markLost')}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {lead.status === 'lost' && lead.lostReason && (
        <Alert>
          <AlertDescription>
            {t('work.lostInfo', { reason: LOST_REASON_LABELS[lead.lostReason][locale] })}
            {lead.statusNote && ` — ${lead.statusNote}`}
          </AlertDescription>
        </Alert>
      )}

      <KeyFacts
        items={[
          {
            label: t('work.kpiLocal', { city: cityOf(lead.timezone, locale) }),
            value: <bdi>{formatTime(lead.timezone, locale, now)}</bdi>,
          },
          { label: t('work.kpiAttempts'), value: <bdi>{lead.contactAttempts}</bdi> },
          { label: t('work.kpiDaysOpen'), value: t('work.days', { count: days }) },
          {
            label: t('work.kpiFollowUp'),
            value: lead.nextFollowUpAt ? (
              <span className="text-base">{relativeTime(lead.nextFollowUpAt, now, locale)}</span>
            ) : (
              '—'
            ),
          },
        ]}
      />

      <Tabs
        dir={dir}
        value={tab}
        onValueChange={(v) =>
          params.set({ tab: v === 'activity' ? null : v }, { resetPage: false })
        }
      >
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="activity">
            {t('work.tabs.activity')} ({lead.activities.length})
          </TabsTrigger>
          <TabsTrigger value="data">{t('work.tabs.data')}</TabsTrigger>
          <TabsTrigger value="trials">
            {t('work.tabs.trials')} ({lead.trials.length})
          </TabsTrigger>
          <TabsTrigger value="family">{t('work.tabs.family')}</TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="mt-2">
          <ActivityPanel
            lead={lead}
            canWrite={can('add_activity')}
            bodyRef={composerRef}
            onSaved={setLead}
          />
        </TabsContent>
        <TabsContent value="data" className="mt-2">
          <DataTab lead={lead} canEdit={can('edit')} onSaved={setLead} />
        </TabsContent>
        <TabsContent value="trials" className="mt-2">
          <TrialsTab lead={lead} />
        </TabsContent>
        <TabsContent value="family" className="mt-2">
          <FamilyTab lead={lead} />
        </TabsContent>
      </Tabs>

      {dialog === 'trial' && (
        <BookTrialDialog lead={lead} onClose={() => setDialog(null)} onSaved={setLead} />
      )}
      {dialog === 'outcome' && (
        <OutcomeDialog lead={lead} onClose={() => setDialog(null)} onSaved={setLead} />
      )}
      {dialog === 'convert' && (
        <ConvertDialog lead={lead} onClose={() => setDialog(null)} onSaved={setLead} />
      )}
      {(dialog === 'lost' ||
        dialog === 'spam' ||
        dialog === 'job_applicant' ||
        dialog === 'reopen') && (
        <ReasonDialog
          open
          destructive={dialog !== 'reopen'}
          onOpenChange={(o) => {
            if (!o) {
              status.reset();
              setDialog(null);
              setLostPreset('');
            }
          }}
          title={t(`confirm.${dialog}Title`)}
          description={
            <>
              <strong>{lead.parentName}</strong> — {t(`confirm.${dialog}Body`)}
              {dialog !== 'reopen' && scheduledTrial && (
                <>
                  {' '}
                  <strong>{t('confirm.trialWillCancel')}</strong>
                </>
              )}
            </>
          }
          confirmLabel={t(`actions.${dialog}`)}
          choices={
            dialog === 'lost'
              ? LOST_REASONS.map((r) => ({ value: r, label: LOST_REASON_LABELS[r][locale] }))
              : undefined
          }
          choiceLabel={t('confirm.reason')}
          defaultChoice={dialog === 'lost' ? lostPreset : undefined}
          textLabel={t('confirm.note')}
          busy={status.isPending}
          error={status.isError ? message(status.error) : null}
          onConfirm={({ text, choice }) => changeStatus(dialog, text, choice)}
        />
      )}
    </div>
  );
}

function AssigneeControl({
  lead,
  canAssign,
  options,
  busy,
  onAssign,
  selfId,
  canTake,
  canRelease,
}: {
  lead: LeadDetailDto;
  canAssign: boolean;
  options: { id: number; name: string }[];
  busy: boolean;
  onAssign: (id: number | null) => void;
  selfId: number;
  canTake: boolean;
  canRelease: boolean;
}) {
  const t = useTranslations('crm');
  const id = useId();
  const NONE = '__none__';
  if (canAssign) {
    const list = [...options];
    if (lead.assignedTo && !list.some((a) => a.id === lead.assignedTo!.id))
      list.push(lead.assignedTo);
    return (
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          {t('work.assignee')}
        </label>
        <Select
          value={lead.assignedTo ? String(lead.assignedTo.id) : NONE}
          onValueChange={(v) => onAssign(v === NONE ? null : Number(v))}
          disabled={busy}
        >
          <SelectTrigger id={id} className="h-9! min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={NONE}>{t('unassigned')}</SelectItem>
            {list.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <span className="flex items-center gap-2 text-sm">
      {t('work.assignee')}: {lead.assignedTo?.name ?? t('unassigned')}
      {canTake && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAssign(selfId)}>
          {t('take')}
        </Button>
      )}
      {canRelease && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAssign(null)}>
          {t('work.release')}
        </Button>
      )}
    </span>
  );
}

// ------------------------------------------------------------------ activity

function ActivityPanel({
  lead,
  canWrite,
  bodyRef,
  onSaved,
}: {
  lead: LeadDetailDto;
  canWrite: boolean;
  bodyRef: React.RefObject<HTMLTextAreaElement | null>;
  onSaved: (d: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm.composer');
  const pane = useRecordPane();
  const tc = useTranslations('crm');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const ids = { body: useId(), result: useId(), date: useId(), time: useId() };
  const [type, setType] = useState<(typeof MANUAL_ACTIVITY_TYPES)[number]>('call');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<CallResult | ''>('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [touched, setTouched] = useState(false);
  const errors = {
    body: type === 'note' && !body.trim() ? t('bodyRequired') : '',
    result: type === 'call' && !result ? t('callResultRequired') : '',
    time: date && !time ? t('timeRequired') : '',
  };
  const add = useMutation({
    mutationFn: () =>
      addLeadActivity(lead.id, {
        type,
        body: body.trim() || null,
        callResult: type === 'call' ? (result as CallResult) : null,
        ...(date && time ? { nextFollowUpAt: zonedInstant(date, time, tz) } : {}),
      }),
    onSuccess: async () => {
      toast.success(t('saved'));
      setBody('');
      setResult('');
      setDate('');
      setTime('');
      setTouched(false);
      const fresh = await queryClient.fetchQuery({
        queryKey: crmKeys.lead(lead.id),
        queryFn: () => fetchLead(lead.id),
        staleTime: 0,
      });
      onSaved(fresh);
    },
  });
  const submit = () => {
    setTouched(true);
    if (errors.body || errors.result || errors.time) return;
    add.mutate();
  };
  return (
    // In the split view's pane (D141 §1) two columns only when the pane itself is wide enough.
    <div
      className={cn(
        'grid gap-4',
        pane ? '@5xl:grid-cols-[minmax(0,26rem)_1fr]' : 'lg:grid-cols-[minmax(0,26rem)_1fr]',
      )}
    >
      {canWrite && (
        <Card className="h-fit gap-3 shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base font-bold">
              <h2>{t('title')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              noValidate
              aria-label={t('title')}
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel>{t('type')}</FieldLabel>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    spacing={0}
                    value={type}
                    aria-label={t('type')}
                    onValueChange={(v) => v && setType(v as typeof type)}
                    className="w-full"
                  >
                    {MANUAL_ACTIVITY_TYPES.map((x) => (
                      <ToggleGroupItem
                        key={x}
                        value={x}
                        className="h-9 flex-1 data-[state=on]:bg-accent data-[state=on]:font-semibold data-[state=on]:text-accent-foreground"
                      >
                        {LEAD_ACTIVITY_LABELS[x][locale]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </Field>
                {type === 'call' && (
                  <Field data-invalid={touched && !!errors.result}>
                    <FieldLabel htmlFor={ids.result}>
                      {t('callResult')}
                      <span aria-hidden className="text-destructive">
                        *
                      </span>
                    </FieldLabel>
                    <Select value={result} onValueChange={(v) => setResult(v as CallResult)}>
                      <SelectTrigger
                        id={ids.result}
                        className="h-10! w-full"
                        aria-invalid={touched && !!errors.result}
                      >
                        <SelectValue placeholder={tc('choose')} />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        {CALL_RESULTS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {CALL_RESULT_LABELS[r][locale]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {touched && errors.result && <FieldError>{errors.result}</FieldError>}
                  </Field>
                )}
                <Field data-invalid={touched && !!errors.body}>
                  <FieldLabel htmlFor={ids.body}>
                    {t('body')}
                    {type === 'note' ? (
                      <span aria-hidden className="text-destructive">
                        *
                      </span>
                    ) : (
                      <span className="font-normal text-muted-foreground">({tc('optional')})</span>
                    )}
                  </FieldLabel>
                  <Textarea
                    id={ids.body}
                    ref={bodyRef}
                    rows={3}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
                    }}
                    aria-invalid={touched && !!errors.body}
                  />
                  <p className="text-xs text-muted-foreground">{t('sendHint')}</p>
                  {touched && errors.body && <FieldError>{errors.body}</FieldError>}
                </Field>
                <Field data-invalid={touched && !!errors.time}>
                  <FieldLabel htmlFor={ids.date}>
                    {t('followUp')}{' '}
                    <span className="font-normal text-muted-foreground">
                      ({t('followUpHelp', { city: cityOf(tz, locale) })})
                    </span>
                  </FieldLabel>
                  <div className="grid grid-cols-[1fr_8rem] gap-2">
                    <DatePicker
                      id={ids.date}
                      value={date}
                      onChange={setDate}
                      min={dateKeyIn(tz)}
                      label={t('followUpDate')}
                    />
                    <TimeSelect
                      id={ids.time}
                      label={t('followUpTime')}
                      value={time}
                      onChange={setTime}
                      invalid={touched && !!errors.time}
                    />
                  </div>
                  {touched && errors.time && <FieldError>{errors.time}</FieldError>}
                </Field>
                {add.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    {message(add.error)}
                  </p>
                )}
                <Button type="submit" className="self-start" disabled={add.isPending}>
                  {add.isPending && <Spinner />}
                  {t('save')}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      )}
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base font-bold">
            <h2>{t('timeline')}</h2>
          </CardTitle>
        </CardHeader>
        {lead.activities.length === 0 ? (
          <p className="p-6 text-center text-muted-foreground">{t('empty')}</p>
        ) : (
          <ol aria-label={t('timeline')} className="divide-y">
            {lead.activities.map((a) => (
              <ActivityItem key={a.id} a={a} />
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function ActivityItem({ a }: { a: LeadActivityDto }) {
  const t = useTranslations('crm.activity');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const meta = a.meta as Record<string, unknown>;
  let line: string = LEAD_ACTIVITY_LABELS[a.type][locale];
  if (a.type === 'call' && a.callResult)
    line = t('callWith', { result: CALL_RESULT_LABELS[a.callResult][locale] });
  if (a.type === 'status_changed' && typeof meta.to === 'string' && meta.to in LEAD_STATUS_LABELS)
    line = t('statusChanged', { to: LEAD_STATUS_LABELS[meta.to as LeadStatus][locale] });
  if (a.type === 'assigned')
    line =
      typeof meta.to === 'string' && meta.to ? t('assigned', { name: meta.to }) : t('unassigned');
  if (
    a.type === 'trial_outcome' &&
    typeof meta.outcome === 'string' &&
    meta.outcome in TRIAL_OUTCOME_LABELS
  )
    line = t('outcome', {
      outcome: TRIAL_OUTCOME_LABELS[meta.outcome as keyof typeof TRIAL_OUTCOME_LABELS][locale],
    });
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold">{line}</span>
        <time dateTime={a.createdAt} className="text-sm text-muted-foreground">
          {formatInstant(a.createdAt, tz, locale)}
        </time>
      </div>
      {a.body && <p className="whitespace-pre-wrap">{a.body}</p>}
      <span className="text-sm text-muted-foreground">{a.user?.name ?? t('system')}</span>
    </li>
  );
}

// ------------------------------------------------------------------ data

function DataTab({
  lead,
  canEdit,
  onSaved,
}: {
  lead: LeadDetailDto;
  canEdit: boolean;
  onSaved: (d: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm');
  const pane = useRecordPane();
  const tv = useTranslations('validation');
  const locale = useUiLocale();
  const message = useCrmError();
  const resolver = useSchemaResolver(updateLeadSchema);
  const form = useForm<LeadFormValues>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      parentName: lead.parentName,
      phone: lead.phone,
      email: lead.email,
      countryCode: lead.countryCode,
      timezone: lead.timezone,
      city: lead.city,
      children: lead.children.length
        ? lead.children.map((c) => ({
            name: c.name ?? '',
            age: c.age ?? null,
            gender: c.gender ?? null,
          }))
        : [{ name: '', age: null, gender: null }],
      courseInterest: lead.courseInterest,
      preferredTimes: lead.preferredTimes,
      message: lead.message,
    },
  });
  const save = useMutation({
    mutationFn: (v: LeadFormValues) => updateLead(lead.id, toLeadBody(v) as UpdateLeadInput),
    onSuccess: (d) => {
      onSaved(d);
      form.reset(form.getValues());
      toast.success(t('form.saved'));
    },
    onError: (e) => {
      if (
        !applyServerErrors(form, e, (k) => tv(k), [
          'parentName',
          'phone',
          'email',
          'countryCode',
          'timezone',
          'children',
        ])
      )
        toast.error(message(e));
    },
  });
  const sch = lead.preferredSchedule;
  const intake = (
    [
      sch && (sch.days?.length || sch.periods?.length || sch.note)
        ? {
            label: t('work.schedule'),
            value: [
              (sch.days ?? []).map((d) => weekdayName(d, locale)).join('، '),
              (sch.periods ?? [])
                .map(
                  (p) =>
                    PREFERRED_PERIOD_LABELS[p as keyof typeof PREFERRED_PERIOD_LABELS]?.[locale] ??
                    p,
                )
                .join('، '),
              sch.note,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : null,
      lead.teacherGenderPref
        ? {
            label: t('work.teacherPref'),
            value:
              TEACHER_GENDER_PREF_LABELS[
                lead.teacherGenderPref as keyof typeof TEACHER_GENDER_PREF_LABELS
              ]?.[locale] ?? lead.teacherGenderPref,
          }
        : null,
      lead.heardFrom
        ? {
            label: t('work.heardFrom'),
            value:
              HEARD_FROM_LABELS[lead.heardFrom as keyof typeof HEARD_FROM_LABELS]?.[locale] ??
              lead.heardFrom,
          }
        : null,
      lead.site ? { label: t('work.site'), value: <bdi dir="ltr">{lead.site}</bdi> } : null,
      lead.utm && Object.keys(lead.utm).length
        ? {
            label: 'UTM',
            value: (
              <bdi dir="ltr">
                {Object.entries(lead.utm)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
              </bdi>
            ),
          }
        : null,
      lead.submissions > 1
        ? { label: t('work.submissions'), value: <bdi>{lead.submissions}</bdi> }
        : null,
    ] as (InfoRow | null)[]
  ).filter((r): r is InfoRow => !!r);
  return (
    // In the split view's pane (D141 §1) two columns only when the pane itself is wide enough.
    <div
      className={cn(
        'grid gap-4',
        pane ? '@5xl:grid-cols-[minmax(0,1fr)_22rem]' : 'lg:grid-cols-[minmax(0,1fr)_22rem]',
      )}
    >
      <Card className="gap-3 shadow-none">
        <CardContent>
          <form noValidate onSubmit={(e) => void form.handleSubmit((v) => save.mutate(v))(e)}>
            <fieldset disabled={!canEdit} className="flex flex-col gap-4">
              <LeadFields control={form.control as Control<LeadFormValues>} withCity withMessage />
              {canEdit && (
                <Button
                  type="submit"
                  variant="outline"
                  className="self-start"
                  disabled={save.isPending}
                >
                  {save.isPending && <Spinner />}
                  {t('form.save')}
                </Button>
              )}
            </fieldset>
          </form>
        </CardContent>
      </Card>
      {intake.length > 0 && (
        <InfoSection title={t('work.intake')} rows={intake} className="h-fit" />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ trials, family

function TrialsTab({ lead }: { lead: LeadDetailDto }) {
  const t = useTranslations('crm.work');
  const locale = useUiLocale();
  if (!lead.trials.length) return <p className="p-4 text-muted-foreground">{t('noTrials')}</p>;
  return (
    <ul className="flex flex-col gap-3">
      {lead.trials.map((x) => (
        <li key={x.sessionId}>
          <Card className="gap-2 shadow-none">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold">
                <span>
                  {x.student.name}
                  {x.course && ` · ${locale === 'ar' ? x.course.nameAr : x.course.nameEn}`}
                </span>
                <ToneBadge
                  tone={
                    x.stage === 'scheduled'
                      ? 'brown'
                      : x.stage === 'cancelled'
                        ? 'grey'
                        : x.stage === 'absent'
                          ? 'red'
                          : 'green'
                  }
                  label={SESSION_STAGE_LABELS[x.stage as SessionStage]?.[locale] ?? x.stage}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              <BothClassTimes at={x.startsAt} otherTz={x.familyZone} party="student" />
              <span className="text-sm text-muted-foreground">
                {t('teacher')}: {x.teacher.name} ·{' '}
                {t('teacherLocal', {
                  time: x.teacherLocal.slice(11),
                  city: cityOf(x.teacherZone, locale),
                })}{' '}
                · {t('minutes', { count: x.durationMinutes })}
              </span>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function FamilyTab({ lead }: { lead: LeadDetailDto }) {
  const t = useTranslations('crm.work');
  const locale = useUiLocale();
  if (!lead.family) return <p className="p-4 text-muted-foreground">{t('noFamily')}</p>;
  return (
    <Card className="gap-3 shadow-none">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 border-b">
        <CardTitle className="text-base font-bold">
          {lead.family.name ?? `#${lead.family.id}`}{' '}
          <Badge variant="outline">{t(`familyStatus.${lead.family.status}`)}</Badge>
        </CardTitle>
        <Button variant="outline" asChild>
          <Link href={`/families/${lead.family.id}`}>{t('openFamily')}</Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {lead.students.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link
                href={`/students/${s.id}`}
                className="font-semibold text-primary hover:underline"
              >
                {s.name}
              </Link>
              <span className="text-sm text-muted-foreground">
                {s.enrollments.length
                  ? s.enrollments
                      .map((e) => t(`enrollmentKind.${e.kind === 'trial' ? 'trial' : 'regular'}`))
                      .join('، ')
                  : t('noEnrollment')}
                {s.age ? ` · ${t('age', { count: s.age })}` : ''}
              </span>
            </li>
          ))}
        </ul>
        {lead.students.length === 0 && <p className="text-muted-foreground">{t('noStudents')}</p>}
        <p className="mt-2 text-sm text-muted-foreground">
          {t('familyZone', { city: cityOf(lead.family.timezone, locale) })}
        </p>
      </CardContent>
    </Card>
  );
}
