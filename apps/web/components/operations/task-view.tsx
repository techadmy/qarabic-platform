'use client';

import {
  reassignTaskSchema,
  TASK_STATUS_LABELS,
  type TaskDetailDto,
  type TaskEventDto,
  type TaskStatus,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@qarabic/ui/components/dropdown-menu';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BanIcon,
  CheckCheckIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchXIcon,
  SendIcon,
  UserRoundPenIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { TextareaField } from '@/components/forms/fields';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
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
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { subjectHref } from '@/lib/operations/time';
import { useDirection } from '@/lib/use-direction';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import {
  AssigneePicker,
  PriorityBadge,
  TaskStatusBadge,
  useOperationsError,
  ViewerTime,
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
  const tv = useTranslations('validation');
  const message = useOperationsError();
  const whoId = useId();
  const [who, setWho] = useState<{ id: number; name: string } | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const resolver = useSchemaResolver(reassignTaskSchema);
  const form = useForm<{ assigneeId: number | null; note: string | null }>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: { assigneeId: null, note: null },
  });
  const done = useTaskWrite(task.id, onClose);
  const save = useMutation({
    mutationFn: (v: { assigneeId: number | null; note: string | null }) =>
      reassignTask(task.id, v.assigneeId!, v.note ?? ''),
    onSuccess: (x) => done(t('reassigned', { name: x.assignee.name }))(x),
    onError: (e) => {
      if (!applyServerErrors(form, e, (k) => tv(k), ['assigneeId', 'note'])) setBanner(message(e));
    },
  });
  const submit = form.handleSubmit((v) => {
    setBanner(null);
    save.mutate(v);
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('reassignTitle')}
      description={t('reassignHint', { name: task.assignee.name })}
      submitLabel={t('reassign')}
      busy={save.isPending}
      error={banner}
      summary={Object.keys(form.formState.errors).length ? t('form.fixErrors') : null}
      onSubmit={() => void submit()}
    >
      <Controller
        control={form.control}
        name="assigneeId"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={whoId}>{t('newAssignee')}</FieldLabel>
            <AssigneePicker
              id={whoId}
              value={who}
              onChange={(p) => {
                setWho(p);
                field.onChange(p?.id ?? null);
              }}
              invalid={fieldState.invalid}
            />
            {fieldState.invalid && (
              <FieldError>
                {fieldState.error?.type === 'server'
                  ? fieldState.error.message
                  : t('form.assigneeRequired')}
              </FieldError>
            )}
          </Field>
        )}
      />
      <TextareaField control={form.control} name="note" label={t('note')} rows={2} />
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
  const me = useCurrentUser();
  const message = useOperationsError();
  const commentId = useId();
  const dir = useDirection();
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
  if (isApiError(query.error, 404)) {
    // Outside my boxes or gone: retrying cannot help.
    return (
      <>
        <PageHeader title={t('detailTitle')} back={back} />
        <EmptyState
          icon={SearchXIcon}
          role="alert"
          title={t('notFound')}
          description={t('notFoundHint')}
          action={
            <Button variant="outline" asChild>
              <Link href="/tasks">{t('backToTasks')}</Link>
            </Button>
          }
        />
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
  type Act = { key: TaskAction | 'reassign' | 'edit'; icon: typeof CheckIcon };
  // The one primary action goes in the header; the rest in «⋯» with «إغلاق» last (destructive).
  const primary: Act | null = x.can.submit
    ? { key: 'submit', icon: SendIcon }
    : x.can.complete
      ? { key: 'complete', icon: CheckCheckIcon }
      : null;
  const more: Act[] = [
    ...(x.can.complete && primary?.key !== 'complete'
      ? [{ key: 'complete' as const, icon: CheckCheckIcon }]
      : []),
    ...(x.can.reopen ? [{ key: 'reopen' as const, icon: RotateCcwIcon }] : []),
    ...(x.can.reassign ? [{ key: 'reassign' as const, icon: UserRoundPenIcon }] : []),
    ...(x.can.edit ? [{ key: 'edit' as const, icon: PencilIcon }] : []),
  ];
  const needsReason = dialog === 'reopen' || dialog === 'close';

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={x.title}
        back={back}
        meta={
          <span className="flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={x.status} overdue={x.overdue} />
            <PriorityBadge priority={x.priority} />
          </span>
        }
        actions={
          (primary || more.length > 0 || x.can.close) && (
            <div className="flex flex-wrap items-center gap-2">
              {primary && (
                <Button className="h-10" onClick={() => setDialog(primary.key)}>
                  <primary.icon />
                  {t(`action.${primary.key}`)}
                </Button>
              )}
              {(more.length > 0 || x.can.close) && (
                <DropdownMenu dir={dir}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="h-10" aria-label={t('moreActions')}>
                      <EllipsisIcon />
                      {primary ? null : t('moreActions')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">
                    {more.map((a) => (
                      <DropdownMenuItem
                        key={a.key}
                        className="min-h-10"
                        onSelect={() => setDialog(a.key)}
                      >
                        <a.icon />
                        {t(`action.${a.key}`)}
                      </DropdownMenuItem>
                    ))}
                    {x.can.close && (
                      <>
                        {more.length > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          variant="destructive"
                          className="min-h-10"
                          onSelect={() => setDialog('close')}
                        >
                          <BanIcon />
                          {t('action.close')}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        }
      />
      <InfoSection
        title={t('details')}
        rows={[
          { label: t('fields.assignee'), value: x.assignee.name },
          { label: t('fields.createdBy'), value: x.createdBy.name },
          {
            label: t('fields.due'),
            value: x.dueAt && (
              <ViewerTime
                at={x.dueAt}
                className={x.overdue ? 'font-semibold text-destructive' : undefined}
              />
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
            <Label htmlFor={commentId} className="font-semibold">
              {t('addComment')}
            </Label>
            <Textarea
              id={commentId}
              dir="auto"
              rows={2}
              maxLength={5000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            {post.isError && (
              <p role="alert" className="text-sm text-destructive">
                {message(post.error)}
              </p>
            )}
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
