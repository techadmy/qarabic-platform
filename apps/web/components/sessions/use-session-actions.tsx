'use client';

import {
  CANCEL_REASONS,
  SESSION_ACTION_LABELS,
  SESSION_STAGE_LABELS,
  STAGE_REASON_LABELS,
  type SessionAction,
  type SessionDto,
  type TransitionInput,
} from '@qarabic/shared';
import { Field, FieldDescription, FieldLabel } from '@qarabic/ui/components/field';
import { Input } from '@qarabic/ui/components/input';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/components/shell/app-shell';
import { isApiError } from '@/lib/api/client';
import { transitionSession, zoomLink } from '@/lib/api/sessions';
import { can } from '@/lib/auth/use-me';
import { UNDO_MS } from '@/lib/people/use-person-actions';
import { upsertSession } from '@/lib/sessions/cache';
import { useClassError } from '@/lib/sessions/errors';
import { minutesBetween } from '@/lib/schedule-time';
import { ReasonDialog, type ReasonResult } from './reason-dialog';
import { useUiLocale } from './times';

type DialogKind =
  | 'mark_absent'
  | 'mark_declined'
  | 'mark_leave'
  | 'cancel'
  | 'revert'
  | 'undo_activate'
  | 'end_early'
  | 'activate_override';

/** Marks that act at once and offer Undo for 8 s (D31). */
const UNDOABLE = new Set<SessionAction>(['mark_absent', 'mark_declined', 'mark_leave']);
/** Display default of `sessions.min_duration_min` (the server enforces the real value). */
const MIN_DURATION = 25;

export interface SessionActionRunner {
  run: (action: SessionAction) => void;
  /** Opens the meeting (start link for the class's teacher, join link for everyone else). */
  openMeeting: (as: 'start' | 'join') => void;
  pending: SessionAction | null;
  /** Render once next to the buttons. */
  dialogs: ReactNode;
}

/**
 * Runs class transitions with the D31 rules (the current app's `useSessionActions`): reversible
 * marks act at once with an Undo toast (after the note dialog when a note is required);
 * destructive ones (cancel, revert, undo activation) confirm first with a reason. The buttons come
 * from `allowedActions`; `expectedStage` + `lockVersion` guard against a stale screen.
 */
export function useSessionActions(session: SessionDto | undefined): SessionActionRunner {
  const t = useTranslations('classes');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const staff = can(me, 'sessions.manage');
  const queryClient = useQueryClient();
  const message = useClassError();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState<SessionAction | null>(null);
  const [notifiedAt, setNotifiedAt] = useState('');
  const [party, setParty] = useState<'student' | 'teacher'>('student');
  const mutation = useMutation({
    mutationFn: (v: { id: number; input: TransitionInput }) => transitionSession(v.id, v.input),
    onSuccess: (s) => upsertSession(queryClient, s),
  });

  const label = (a: string) =>
    SESSION_ACTION_LABELS[a as SessionAction]?.[locale] ?? SESSION_ACTION_LABELS.end[locale];

  function exec(action: SessionAction, extra: Partial<TransitionInput> = {}, fromDialog = false) {
    if (!session) return;
    setPending(action);
    mutation.mutate(
      {
        id: session.id,
        input: {
          action,
          expectedStage: session.stage,
          lockVersion: session.lockVersion,
          ...extra,
        },
      },
      {
        onSuccess: (s) => {
          setDialog(null);
          setDialogError(null);
          const done = t(`done.${action}`, { name: session.student.name });
          if (UNDOABLE.has(action) && s.allowedActions.includes('undo_mark')) {
            toast.success(done, {
              duration: UNDO_MS,
              action: {
                label: t('undo'),
                onClick: () =>
                  void transitionSession(s.id, { action: 'undo_mark', expectedStage: s.stage })
                    .then((back) => {
                      upsertSession(queryClient, back);
                      toast.success(t('done.undo_mark'));
                    })
                    .catch((e: unknown) => toast.error(message(e))),
              },
            });
          } else {
            toast.success(done);
          }
        },
        onError: (e) => {
          // Staff may activate outside the window with a reason (override, audited).
          if (action === 'activate' && staff && !fromDialog && isApiError(e, 422)) {
            setDialog('activate_override');
            return;
          }
          if (fromDialog) setDialogError(message(e));
          else toast.error(message(e));
        },
        onSettled: () => setPending(null),
      },
    );
  }

  function openMeeting(as: 'start' | 'join') {
    if (!session) return;
    // Open the tab inside the click (popup blockers), then point it at the link.
    const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
    zoomLink(session.id, as)
      .then((url) => {
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          toast.info(t('meeting.blocked'));
        }
      })
      .catch((e: unknown) => {
        tab?.close();
        toast.error(message(e));
      });
  }

  function run(action: SessionAction) {
    if (!session) return;
    setDialogError(null);
    switch (action) {
      case 'mark_absent':
      case 'mark_declined':
      case 'cancel':
      case 'revert':
      case 'undo_activate':
        setDialog(action);
        return;
      case 'mark_leave':
        setNotifiedAt('');
        setParty('student');
        setDialog('mark_leave');
        return;
      case 'end': {
        const elapsed = minutesBetween(session.times.activatedAt ?? session.startsAt, new Date());
        if (staff && elapsed < MIN_DURATION) setDialog('end_early');
        else exec('end');
        return;
      }
      default:
        exec(action);
    }
  }

  const close = (open: boolean) => {
    if (!open && !mutation.isPending) setDialog(null);
  };
  const name = session?.student.name ?? '';
  const confirm =
    (action: SessionAction, build: (r: ReasonResult) => Partial<TransitionInput>) =>
    (r: ReasonResult) =>
      exec(action, build(r), true);

  const dialogs = session ? (
    <>
      <ReasonDialog
        open={dialog === 'mark_absent'}
        onOpenChange={close}
        title={t('dialog.absentTitle', { name })}
        description={t('dialog.absentBody')}
        confirmLabel={label('mark_absent')}
        textLabel={t('dialog.note')}
        textRequired
        busy={pending === 'mark_absent'}
        error={dialogError}
        onConfirm={confirm('mark_absent', (r) => ({ note: r.text }))}
      />
      <ReasonDialog
        open={dialog === 'mark_declined'}
        onOpenChange={close}
        title={t('dialog.declinedTitle', { name })}
        description={t('dialog.declinedBody')}
        confirmLabel={label('mark_declined')}
        textLabel={t('dialog.note')}
        textRequired
        busy={pending === 'mark_declined'}
        error={dialogError}
        onConfirm={confirm('mark_declined', (r) => ({ note: r.text }))}
      />
      <ReasonDialog
        open={dialog === 'mark_leave'}
        onOpenChange={close}
        title={t('dialog.leaveTitle', { name })}
        description={t('dialog.leaveBody')}
        confirmLabel={label('mark_leave')}
        textLabel={t('dialog.note')}
        busy={pending === 'mark_leave'}
        error={dialogError}
        extra={
          <>
            {staff && (
              <Field>
                <FieldLabel>{t('dialog.leaveParty')}</FieldLabel>
                <RadioGroup
                  value={party}
                  onValueChange={(v) => setParty(v as 'student' | 'teacher')}
                  className="flex gap-6"
                >
                  {(['student', 'teacher'] as const).map((p) => (
                    <Field key={p} orientation="horizontal" className="w-auto">
                      <RadioGroupItem value={p} id={`leave-party-${p}`} />
                      <FieldLabel htmlFor={`leave-party-${p}`} className="font-normal">
                        {STAGE_REASON_LABELS[p][locale]}
                      </FieldLabel>
                    </Field>
                  ))}
                </RadioGroup>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="leave-notified-at">{t('dialog.notifiedAt')}</FieldLabel>
              <Input
                id="leave-notified-at"
                type="datetime-local"
                dir="ltr"
                className="h-10 text-start"
                value={notifiedAt}
                onChange={(e) => setNotifiedAt(e.target.value)}
              />
              <FieldDescription>{t('dialog.notifiedAtHelp')}</FieldDescription>
            </Field>
          </>
        }
        onConfirm={confirm('mark_leave', (r) => ({
          note: r.text || undefined,
          // datetime-local is the viewer's wall time; Date() reads it in the browser's zone.
          notifiedAt: notifiedAt ? new Date(notifiedAt).toISOString() : undefined,
          stageReason: party,
        }))}
      />
      <ReasonDialog
        open={dialog === 'cancel'}
        onOpenChange={close}
        destructive
        title={t('dialog.cancelTitle', { name })}
        description={t('dialog.cancelBody')}
        confirmLabel={label('cancel')}
        choices={CANCEL_REASONS.map((r) => ({ value: r, label: STAGE_REASON_LABELS[r][locale] }))}
        choiceLabel={t('dialog.reason')}
        textLabel={t('dialog.note')}
        busy={pending === 'cancel'}
        error={dialogError}
        onConfirm={confirm('cancel', (r) => ({
          stageReason: r.choice,
          note: r.text || undefined,
        }))}
      />
      <ReasonDialog
        open={dialog === 'revert'}
        onOpenChange={close}
        destructive
        title={t('dialog.revertTitle', { name })}
        description={t('dialog.revertBody', {
          stage: SESSION_STAGE_LABELS[session.stage][locale],
        })}
        confirmLabel={label('revert')}
        textLabel={t('dialog.reason')}
        textRequired
        busy={pending === 'revert'}
        error={dialogError}
        onConfirm={confirm('revert', (r) => ({ reason: r.text }))}
      />
      <ReasonDialog
        open={dialog === 'undo_activate'}
        onOpenChange={close}
        destructive
        title={t('dialog.undoActivateTitle')}
        description={t('dialog.undoActivateBody')}
        confirmLabel={label('undo_activate')}
        textLabel={staff ? t('dialog.reason') : undefined}
        textRequired={staff}
        busy={pending === 'undo_activate'}
        error={dialogError}
        onConfirm={confirm('undo_activate', (r) => ({ reason: r.text || undefined }))}
      />
      <ReasonDialog
        open={dialog === 'activate_override'}
        onOpenChange={close}
        title={t('dialog.overrideTitle', { name })}
        description={t('dialog.overrideBody')}
        confirmLabel={label('activate')}
        textLabel={t('dialog.reason')}
        textRequired
        busy={pending === 'activate'}
        error={dialogError}
        onConfirm={confirm('activate', (r) => ({ override: true, reason: r.text }))}
      />
      <ReasonDialog
        open={dialog === 'end_early'}
        onOpenChange={close}
        title={t('dialog.endEarlyTitle', { min: MIN_DURATION })}
        description={t('dialog.endEarlyBody')}
        confirmLabel={label('end')}
        textLabel={t('dialog.reason')}
        textRequired
        busy={pending === 'end'}
        error={dialogError}
        onConfirm={confirm('end', (r) => ({ reason: r.text }))}
      />
    </>
  ) : null;

  return { run, openMeeting, pending, dialogs };
}
