'use client';

import {
  TASK_STATUS_LABELS,
  type TaskDetailDto,
  type TaskEventDto,
  type TaskStatus,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BanIcon,
  CheckCheckIcon,
  CheckIcon,
  PencilIcon,
  RotateCcwIcon,
  SendIcon,
  UserRoundPenIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FormRow } from '@/components/billing/billing-bits';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState, ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/client';
import {
  commentOnTask,
  fetchTask,
  operationsKeys,
  reassignTask,
  taskAction,
  type TaskAction,
} from '@/lib/api/operations';
import { can } from '@/lib/auth/use-me';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import {
  AssigneePicker,
  PriorityBadge,
  subjectHref,
  TaskStatusBadge,
  useOperationsError,
} from './ops-bits';
import { TaskDialog } from './task-dialog';

function useTaskWrite(id: number, done: () => void) {
  const queryClient = useQueryClient();
  return (text: string) => (task: TaskDetailDto) => {
    queryClient.setQueryData(operationsKeys.task(id), task);
    void queryClient.invalidateQueries({ queryKey: ['operations', 'tasks'] });
    done();
    toast.success(text);
  };
}

function ReassignDialog({ task, onClose }: { task: TaskDetailDto; onClose: () => void }) {
  const t = useTranslations('operations.tasks');
  const message = useOperationsError();
  const ids = { who: useId(), note: useId() };
  const [who, setWho] = useState<{ id: number; name: string } | null>(null);
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const done = useTaskWrite(task.id, onClose);
  const save = useMutation({
    mutationFn: () => reassignTask(task.id, who!.id, note.trim()),
    onSuccess: (x) => done(t('reassigned', { name: x.assignee.name }))(x),
  });
  const err = touched && !who ? t('form.assigneeRequired') : null;
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('reassignTitle')}
      description={t('reassignHint', { name: task.assignee.name })}
      submitLabel={t('reassign')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={err}
      onSubmit={() => {
        setTouched(true);
        if (who) save.mutate();
      }}
    >
      <FormRow id={ids.who} label={t('newAssignee')} required error={err}>
        <AssigneePicker id={ids.who} value={who} onChange={setWho} invalid={!!err} />
      </FormRow>
      <FormRow id={ids.note} label={t('note')}>
        <Textarea
          id={ids.note}
          dir="auto"
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="md:text-[0.9375rem]"
        />
      </FormRow>
    </FormDialog>
  );
}

function EventItem({ e }: { e: TaskEventDto }) {
  const t = useTranslations('operations.tasks.timeline');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(60_000);
  const by = e.author?.name ?? t('system');
  const text = (() => {
    switch (e.kind) {
      case 'created':
        return t('created', { by });
      case 'comment':
        return t('commented', { by });
      case 'updated':
        return t('updated', { by });
      case 'reassigned': {
        const to = (e.data.to as { name?: string } | undefined)?.name ?? '';
        return t('reassigned', { by, to });
      }
      case 'status': {
        const to = e.data.to as TaskStatus | undefined;
        return t('status', { by, status: to ? TASK_STATUS_LABELS[to][locale] : '' });
      }
    }
  })();
  return (
    <li className="flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={e.kind === 'comment' ? 'font-semibold' : 'text-sm'}>{text}</span>
        <time
          dateTime={e.createdAt}
          title={dayAndClock(e.createdAt, tz, locale)}
          className="text-sm text-muted-foreground"
        >
          {relativeTime(e.createdAt, now, locale)}
        </time>
      </div>
      {e.body && <p className="break-words whitespace-pre-wrap">{e.body}</p>}
    </li>
  );
}

/**
 * One task (M8): what, who gave it to whom, due, the record it is about, and the buttons the
 * server allows now (`can`): «أنجزت المهمة» (assignee), «اعتماد الإنجاز» (issuer), «إعادة فتح» and
 * «إغلاق» with a reason, «تحويل» to someone else, «تعديل». The timeline below is append-only;
 * anyone who sees the task may comment.
 */
export function TaskView({ id }: { id: number }) {
  const t = useTranslations('operations.tasks');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const me = useCurrentUser();
  const message = useOperationsError();
  const commentId = useId();
  const [dialog, setDialog] = useState<TaskAction | 'reassign' | 'edit' | null>(null);
  const [comment, setComment] = useState('');
  const query = useQuery({
    queryKey: operationsKeys.task(id),
    queryFn: ({ signal }) => fetchTask(id, signal),
    enabled: can(me, 'tasks.view'),
  });
  const done = useTaskWrite(id, () => setDialog(null));
  const act = useMutation({
    mutationFn: (v: { action: TaskAction; text: string }) => taskAction(id, v.action, v.text),
    onSuccess: (x, v) => done(t(`done.${v.action}`))(x),
  });
  const post = useMutation({
    mutationFn: () => commentOnTask(id, comment.trim()),
    onSuccess: (x) => {
      setComment('');
      done(t('commentAdded'))(x);
    },
  });
  const back = { href: '/tasks', label: t('title') };
  if (!can(me, 'tasks.view') || isApiError(query.error, 403)) {
    return (
      <>
        <PageHeader title={t('detailTitle')} back={back} />
        <ForbiddenState />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        <PageHeader title={t('detailTitle')} back={back} />
        <ErrorState onRetry={() => void query.refetch()} />
      </>
    );
  }
  if (!query.data) return <ProfileSkeleton />;
  const x = query.data;
  const actions: {
    key: TaskAction | 'reassign' | 'edit';
    icon: typeof CheckIcon;
    primary?: boolean;
  }[] = [
    ...(x.can.submit ? [{ key: 'submit' as const, icon: SendIcon, primary: true }] : []),
    ...(x.can.complete
      ? [{ key: 'complete' as const, icon: CheckCheckIcon, primary: !x.can.submit }]
      : []),
    ...(x.can.reopen ? [{ key: 'reopen' as const, icon: RotateCcwIcon }] : []),
    ...(x.can.reassign ? [{ key: 'reassign' as const, icon: UserRoundPenIcon }] : []),
    ...(x.can.edit ? [{ key: 'edit' as const, icon: PencilIcon }] : []),
    ...(x.can.close ? [{ key: 'close' as const, icon: BanIcon }] : []),
  ];
  const needsReason = dialog === 'reopen' || dialog === 'close';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <PageHeader
        title={x.title}
        back={back}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={x.status} overdue={x.overdue} />
            <PriorityBadge priority={x.priority} />
          </span>
        }
      />
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('actions')}>
          {actions.map((a) => (
            <Button
              key={a.key}
              variant={a.primary ? 'default' : 'outline'}
              className="h-10"
              onClick={() => setDialog(a.key)}
            >
              <a.icon />
              {t(`action.${a.key}`)}
            </Button>
          ))}
        </div>
      )}
      <InfoSection
        title={t('details')}
        rows={[
          { label: t('fields.assignee'), value: x.assignee.name },
          { label: t('fields.createdBy'), value: x.createdBy.name },
          {
            label: t('fields.due'),
            value: x.dueAt && (
              <span className={x.overdue ? 'font-semibold text-destructive' : undefined}>
                {dayAndClock(x.dueAt, tz, locale)}
              </span>
            ),
          },
          {
            label: t('fields.subject'),
            value: x.subjectType && x.subjectId && (
              <Link
                href={subjectHref(x.subjectType, x.subjectId)}
                className="font-semibold text-primary hover:underline"
              >
                {t(`subject.${x.subjectType}`, { id: x.subjectId })}
              </Link>
            ),
          },
          { label: t('fields.description'), value: x.description, wide: true },
          ...(x.closeReason ? [{ label: t('closeReason'), value: x.closeReason, wide: true }] : []),
        ]}
      />
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base font-bold">
            <h2>{t('timelineTitle')}</h2>
          </CardTitle>
        </CardHeader>
        <ol className="flex flex-col divide-y" aria-label={t('timelineTitle')}>
          {x.events.map((e) => (
            <EventItem key={e.id} e={e} />
          ))}
        </ol>
        <CardContent className="border-t py-4">
          <form
            className="flex flex-col gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (comment.trim()) post.mutate();
            }}
          >
            <label htmlFor={commentId} className="font-semibold">
              {t('addComment')}
            </label>
            <Textarea
              id={commentId}
              dir="auto"
              rows={2}
              maxLength={5000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              className="md:text-[0.9375rem]"
            />
            {post.isError && <p className="text-sm text-destructive">{message(post.error)}</p>}
            <Button
              type="submit"
              className="h-10 self-end"
              disabled={!comment.trim() || post.isPending}
            >
              {post.isPending && <Spinner />}
              {t('send')}
            </Button>
          </form>
        </CardContent>
      </Card>
      {(dialog === 'submit' || dialog === 'complete' || needsReason) && (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setDialog(null);
              act.reset();
            }
          }}
          destructive={dialog === 'close'}
          title={t(`confirm.${dialog}`, { title: x.title })}
          description={t(`hint.${dialog}`)}
          confirmLabel={t(`action.${dialog}`)}
          textLabel={needsReason ? t('reason') : t('note')}
          textRequired={needsReason}
          textMin={needsReason ? 3 : undefined}
          busy={act.isPending}
          error={act.isError ? message(act.error) : null}
          onConfirm={({ text }) => act.mutate({ action: dialog, text })}
        />
      )}
      {dialog === 'reassign' && <ReassignDialog task={x} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && (
        <TaskDialog open task={x} onOpenChange={(o) => !o && setDialog(null)} />
      )}
    </div>
  );
}
