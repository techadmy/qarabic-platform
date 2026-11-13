'use client';

import {
  INVOICE_TOPIC_LABELS,
  REQUEST_STATE_LABELS,
  SUBSCRIPTION_REASON_LABELS,
  TEACHER_CHANGE_REASON_LABELS,
  type SupportRequestAction,
  type SupportRequestDto,
  type TicketDetailDto,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Field, FieldLabel } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Combobox } from '@/components/forms/fields';
import { DatePicker } from '@/components/forms/date-time';
import { useLookups } from '@/components/people/person-sheet';
import { ToneBadge } from '@/components/sessions/badges';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { answerRequest, requestAction, supportKeys } from '@/lib/api/support';
import { can } from '@/lib/auth/use-me';
import {
  dateKeyIn,
  dayAndClock,
  dayLabel,
  otherSideOf,
  wallTime,
  weekdayName,
} from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { useSupportError } from '@/lib/support/errors';

const TONE = {
  submitted: 'brown',
  proposed: 'brown',
  accepted: 'green',
  declined: 'red',
  approved: 'green',
  rejected: 'grey',
  done: 'green',
} as const;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * A typed request on its ticket (S3, docs/32 §3 #4–#7): what was asked (times, reason, dates,
 * topic), where it stands, and the next step — for staff who handle the queue: propose a teacher
 * (teacher change), approve, mark done, or reject with a note; for the family: accept or decline
 * the proposed teacher. The change itself is made with the usual tools; «تم التنفيذ» records it.
 */
export function RequestCard({ ticket }: { ticket: TicketDetailDto }) {
  const t = useTranslations('support.request');
  const tf = useTranslations('support.form');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const message = useSupportError();
  const r = ticket.request!;
  // What this viewer may do next comes from the server (state and permission rules, #64).
  const may = (a: SupportRequestAction) => r.allowedActions.includes(a);
  const staffSteps = (['propose', 'approve', 'complete', 'reject'] as const).some(may);
  // Staff wording for the people who handle requests, the family's wording for the family.
  const staff =
    !ticket.isMine &&
    (can(me, 'support.handle') || can(me, 'support.manage') || can(me, 'feedback.manage'));
  const [proposing, setProposing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  /** A step that waits for «تأكيد» (D31): what it does is said first. */
  const [confirming, setConfirming] = useState<
    'approve' | 'complete' | 'accept' | 'decline' | null
  >(null);
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: supportKeys.all });
  };
  const act = useMutation({
    mutationFn: (v: Parameters<typeof requestAction>[1]) => requestAction(ticket.id, v),
    onSuccess: (_, v) => {
      setProposing(false);
      setRejecting(false);
      setConfirming(null);
      done();
      toast.success(t(`done.${v.action}`));
    },
    // Refusals show inside the open dialog.
    onError: () => undefined,
  });
  const answer = useMutation({
    mutationFn: (v: { accept: boolean; note?: string }) =>
      answerRequest(ticket.id, { accept: v.accept, note: v.note || undefined }),
    onSuccess: (_, v) => {
      setConfirming(null);
      done();
      toast.success(t(v.accept ? 'answered.accept' : 'answered.decline'));
    },
  });

  const rows = details(r, locale, tz, t);
  const stateLabel = staff ? t(`staffState.${r.state}`) : REQUEST_STATE_LABELS[r.state][locale];
  const btn = 'h-11 md:h-10';
  return (
    <Card role="region" className="gap-2 shadow-none" aria-labelledby="ticket-request">
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold">
          <h2 id="ticket-request">{t('title', { kind: tf(`choice.${r.kind}`) })}</h2>
          <ToneBadge tone={TONE[r.state]} label={stateLabel} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {r.proposal && (
            <div className="contents">
              <dt className="text-muted-foreground">{t('proposal')}</dt>
              <dd>
                {t('proposalValue', {
                  name: r.proposal.teacher.name,
                  date: dayLabel(r.proposal.fromDate, locale),
                })}
              </dd>
            </div>
          )}
          {r.decidedBy && r.decidedAt && (
            <div className="contents">
              <dt className="text-muted-foreground">{t('lastStep')}</dt>
              <dd>
                <bdi>{r.decidedBy.name}</bdi> · {dayAndClock(r.decidedAt, tz, locale)}
              </dd>
            </div>
          )}
          {r.note && (
            <div className="contents">
              <dt className="text-muted-foreground">{t('note')}</dt>
              <dd className="whitespace-pre-line">{r.note}</dd>
            </div>
          )}
        </dl>
        {(may('accept') || may('decline')) && (
          <div className="flex flex-wrap gap-2">
            {may('accept') && (
              <Button className={btn} onClick={() => (answer.reset(), setConfirming('accept'))}>
                {t('accept')}
              </Button>
            )}
            {may('decline') && (
              <Button
                variant="outline"
                className={btn}
                onClick={() => (answer.reset(), setConfirming('decline'))}
              >
                {t('decline')}
              </Button>
            )}
          </div>
        )}
        {staffSteps && (
          <div className="flex flex-wrap gap-2">
            {may('propose') && (
              <Button className={btn} onClick={() => (act.reset(), setProposing(true))}>
                {r.state === 'proposed' ? t('reproposeTeacher') : t('proposeTeacher')}
              </Button>
            )}
            {may('approve') && (
              <Button className={btn} onClick={() => (act.reset(), setConfirming('approve'))}>
                {t('approve')}
              </Button>
            )}
            {may('complete') && (
              <Button className={btn} onClick={() => (act.reset(), setConfirming('complete'))}>
                {t('complete')}
              </Button>
            )}
            {may('reject') && (
              <Button
                variant="ghost"
                className={btn}
                onClick={() => {
                  act.reset();
                  setRejecting(true);
                }}
              >
                {t('reject')}
              </Button>
            )}
          </div>
        )}
        {staffSteps && <p className="text-sm text-muted-foreground">{t('doneHint')}</p>}
      </CardContent>
      <ReasonDialog
        open={rejecting}
        onOpenChange={setRejecting}
        title={t('rejectTitle')}
        description={t('rejectHint')}
        confirmLabel={t('reject')}
        destructive
        textLabel={t('rejectNote')}
        textRequired
        textMin={3}
        busy={act.isPending}
        error={act.isError && act.variables?.action === 'reject' ? message(act.error) : null}
        onConfirm={({ text }) => act.mutate({ action: 'reject', note: text })}
      />
      <ReasonDialog
        open={confirming === 'approve' || confirming === 'complete'}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming === 'complete' ? t('completeTitle') : t('approveTitle')}
        description={confirming === 'complete' ? t('completeHint') : t('approveHint')}
        confirmLabel={confirming === 'complete' ? t('complete') : t('approve')}
        textLabel={t('noteOptional')}
        busy={act.isPending}
        error={
          act.isError &&
          (act.variables?.action === 'approve' || act.variables?.action === 'complete')
            ? message(act.error)
            : null
        }
        onConfirm={({ text }) =>
          act.mutate({
            action: confirming === 'complete' ? 'complete' : 'approve',
            note: text || undefined,
          })
        }
      />
      <ReasonDialog
        open={confirming === 'accept' || confirming === 'decline'}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={confirming === 'accept' ? t('acceptTitle') : t('declineTitle')}
        description={
          r.proposal
            ? t(confirming === 'accept' ? 'acceptHint' : 'declineHint', {
                name: r.proposal.teacher.name,
                date: dayLabel(r.proposal.fromDate, locale),
              })
            : undefined
        }
        confirmLabel={confirming === 'accept' ? t('accept') : t('decline')}
        textLabel={confirming === 'decline' ? t('declineNote') : undefined}
        busy={answer.isPending}
        error={answer.isError ? message(answer.error) : null}
        onConfirm={({ text }) => answer.mutate({ accept: confirming === 'accept', note: text })}
      />
      {proposing && (
        <ProposeDialog
          busy={act.isPending}
          error={act.isError && act.variables?.action === 'propose' ? message(act.error) : null}
          today={dateKeyIn(tz)}
          onClose={() => setProposing(false)}
          onPropose={(teacherId, fromDate) =>
            act.mutate({ action: 'propose', proposal: { teacherId, fromDate } })
          }
        />
      )}
    </Card>
  );
}

function ProposeDialog({
  busy,
  error,
  today,
  onClose,
  onPropose,
}: {
  busy: boolean;
  error: string | null;
  today: string;
  onClose: () => void;
  onPropose: (teacherId: number, fromDate: string) => void;
}) {
  const t = useTranslations('support.request');
  const lookups = useLookups();
  const ids = { teacher: useId(), date: useId() };
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState(today);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('proposeTeacher')}</DialogTitle>
          <DialogDescription>{t('proposeHint')}</DialogDescription>
        </DialogHeader>
        {lookups.isError && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            {t('teachersFailed')}
            <Button variant="outline" size="sm" onClick={() => void lookups.refetch()}>
              {t('retry')}
            </Button>
          </p>
        )}
        <Field>
          <FieldLabel htmlFor={ids.teacher}>{t('teacher')}</FieldLabel>
          <Combobox
            id={ids.teacher}
            value={teacherId}
            onChange={setTeacherId}
            options={(lookups.data?.teachers ?? []).map((x) => ({
              value: String(x.id),
              label: x.name,
            }))}
            placeholder={t('choose')}
            searchPlaceholder={t('searchTeacher')}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={ids.date}>{t('fromDate')}</FieldLabel>
          <DatePicker id={ids.date} value={fromDate} min={today} onChange={setFromDate} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-10" onClick={onClose}>
            {t('back')}
          </Button>
          <Button
            className="h-11 md:h-10"
            disabled={!teacherId || !fromDate || busy}
            onClick={() => teacherId && onPropose(Number(teacherId), fromDate)}
          >
            {busy && <Spinner />}
            {t('propose')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What was asked, as label → value rows. */
function details(
  r: SupportRequestDto,
  locale: 'ar' | 'en',
  viewerTz: string,
  t: ReturnType<typeof useTranslations<'support.request'>>,
): [string, ReactNode][] {
  const p = r.payload;
  if (r.kind === 'schedule_change') {
    const slots = Array.isArray(p.slots)
      ? (p.slots as { weekday: number; localTime: string }[])
      : [];
    // D30: the times in the zone they were asked in, labelled, and the viewer's own beside them.
    const zone = str(p.timezone) || viewerTz;
    const from = str(p.startsOn) || dateKeyIn(viewerTz);
    return [
      [
        t('newTimes'),
        <span key="s" className="flex flex-col gap-1">
          {slots.map((s, i) => {
            const mine =
              zone !== viewerTz
                ? otherSideOf(
                    { weekday: s.weekday, localStartTime: s.localTime, timezone: zone },
                    viewerTz,
                    from,
                  )
                : null;
            return (
              <span key={i}>
                <bdi>
                  {weekdayName(s.weekday, locale)} {wallTime(s.localTime, locale)} (
                  {cityOf(zone, locale)})
                </bdi>
                {mine && (
                  <span className="block text-sm text-muted-foreground">
                    <bdi>
                      {t('yourTime', {
                        time: `${weekdayName(mine.weekday, locale)} ${wallTime(mine.time, locale)}`,
                        city: cityOf(viewerTz, locale),
                      })}
                    </bdi>
                  </span>
                )}
              </span>
            );
          })}
        </span>,
      ],
      [t('startsOn'), dayLabel(str(p.startsOn), locale)],
    ];
  }
  if (r.kind === 'teacher_change') {
    const reason = str(p.reason) as keyof typeof TEACHER_CHANGE_REASON_LABELS;
    const gender = str(p.preferredGender);
    return [
      [t('teacherReason'), TEACHER_CHANGE_REASON_LABELS[reason]?.[locale] ?? '—'],
      [
        t('preferredGender'),
        gender === 'male'
          ? t('genderMale')
          : gender === 'female'
            ? t('genderFemale')
            : t('genderAny'),
      ],
      ...(str(p.preferredTimes)
        ? [[t('preferredTimes'), str(p.preferredTimes)] as [string, ReactNode]]
        : []),
    ];
  }
  if (r.kind === 'subscription_change') {
    const reason = str(p.reason) as keyof typeof SUBSCRIPTION_REASON_LABELS;
    const ids = Array.isArray(p.studentIds) ? p.studentIds : [];
    return [
      [t('subscriptionAction'), t(`actions.${str(p.action) === 'stop' ? 'stop' : 'pause'}`)],
      [
        t('period'),
        p.to
          ? t('periodValue', {
              from: dayLabel(str(p.from), locale),
              to: dayLabel(str(p.to), locale),
            })
          : t('fromValue', { from: dayLabel(str(p.from), locale) }),
      ],
      [t('subscriptionReason'), SUBSCRIPTION_REASON_LABELS[reason]?.[locale] ?? '—'],
      [t('who'), ids.length ? t('oneChild') : t('wholeFamily')],
    ];
  }
  const topic = str(p.topic) as keyof typeof INVOICE_TOPIC_LABELS;
  return [[t('topic'), INVOICE_TOPIC_LABELS[topic]?.[locale] ?? '—']];
}
