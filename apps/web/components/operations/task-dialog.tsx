'use client';

import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  type TaskDetailDto,
  type TaskPriority,
} from '@qarabic/shared';
import { Input } from '@qarabic/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { FormRow, NUMBER_INPUT } from '@/components/billing/billing-bits';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { createTask, fetchTaskTemplates, operationsKeys, updateTask } from '@/lib/api/operations';
import { addDays, dateKeyIn, zonedInstant } from '@/lib/schedule-time';
import { AssigneePicker, useOperationsError } from './ops-bits';

const NONE = '__none__';
const TIME = /^\d{2}:\d{2}$/;

/** The due date and time of a task as the viewer typed them (their zone, D30) → ISO. */
export function dueInstant(date: string, time: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return zonedInstant(date, TIME.test(time) ? time : '17:00', tz);
}

/**
 * «مهمة جديدة» / «تعديل المهمة» (M8, old Given / Issued tasks): title, details, who does it,
 * priority and the due time in the viewer's zone; a template fills the title, details, priority
 * and due date. `subject` links the task to a record (from that record's page).
 */
export function TaskDialog({
  open,
  onOpenChange,
  task,
  subject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this task (title, details, priority, due) instead of creating one. */
  task?: TaskDetailDto;
  subject?: { type: TaskDetailDto['subjectType'] & string; id: number; label: string };
}) {
  const t = useTranslations('operations.tasks');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const ids = {
    template: useId(),
    title: useId(),
    description: useId(),
    assignee: useId(),
    priority: useId(),
    date: useId(),
    time: useId(),
  };
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [assignee, setAssignee] = useState<{ id: number; name: string } | null>(
    task?.assignee ?? null,
  );
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'normal');
  const [date, setDate] = useState(task?.dueAt ? dateKeyIn(tz, new Date(task.dueAt)) : '');
  const [time, setTime] = useState(
    task?.dueAt
      ? new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: tz,
        }).format(new Date(task.dueAt))
      : '',
  );
  const [touched, setTouched] = useState(false);
  const templates = useQuery({
    queryKey: operationsKeys.templates,
    queryFn: ({ signal }) => fetchTaskTemplates(signal),
    enabled: open && !task,
  });
  const errors = {
    title: title.trim().length >= 3 ? null : 'titleRequired',
    assignee: task || assignee ? null : 'assigneeRequired',
  };
  const err = (k: keyof typeof errors) => (touched && errors[k] ? t(`form.${errors[k]}`) : null);
  const ok = !errors.title && !errors.assignee;
  const save = useMutation({
    mutationFn: () => {
      const dueAt = dueInstant(date, time, tz);
      return task
        ? updateTask(task.id, {
            title: title.trim(),
            description: description.trim() || null,
            priority,
            dueAt,
          })
        : createTask({
            title: title.trim(),
            description: description.trim() || null,
            assigneeId: assignee!.id,
            priority,
            dueAt,
            ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}),
            ...(templateId ? { templateId } : {}),
          });
    },
    onSuccess: (x) => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      toast.success(task ? t('saved') : t('created', { name: x.assignee.name }));
      onOpenChange(false);
      if (!task) router.push(`/tasks/${x.id}`);
    },
  });

  function applyTemplate(v: string) {
    const tpl = templates.data?.find((x) => String(x.id) === v);
    setTemplateId(tpl?.id ?? null);
    if (!tpl) return;
    setTitle(tpl.title);
    setDescription(tpl.description ?? '');
    setPriority(tpl.priority);
    if (tpl.dueInDays !== null) setDate(addDays(dateKeyIn(tz), tpl.dueInDays));
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={task ? t('editTitle') : t('newTitle')}
      description={subject ? t('aboutSubject', { label: subject.label }) : undefined}
      submitLabel={task ? t('save') : t('create')}
      busy={save.isPending}
      error={save.isError ? message(save.error) : null}
      summary={touched && !ok ? t('form.fixErrors') : null}
      onSubmit={() => {
        setTouched(true);
        if (ok) save.mutate();
      }}
    >
      {!task && (templates.data?.length ?? 0) > 0 && (
        <FormRow id={ids.template} label={t('template')} hint={t('templateHint')}>
          <Select value={templateId ? String(templateId) : NONE} onValueChange={applyTemplate}>
            <SelectTrigger id={ids.template} className="h-10! w-full md:text-[0.9375rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={NONE}>{t('noTemplate')}</SelectItem>
              {templates.data!.map((x) => (
                <SelectItem key={x.id} value={String(x.id)}>
                  {x.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
      )}
      <FormRow id={ids.title} label={t('fields.title')} required error={err('title')}>
        <Input
          id={ids.title}
          dir="auto"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-invalid={!!err('title')}
          aria-describedby={err('title') ? `${ids.title}-error` : undefined}
          className="h-10 md:text-[0.9375rem]"
        />
      </FormRow>
      <FormRow id={ids.description} label={t('fields.description')}>
        <Textarea
          id={ids.description}
          dir="auto"
          rows={3}
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="md:text-[0.9375rem]"
        />
      </FormRow>
      {!task && (
        <FormRow id={ids.assignee} label={t('fields.assignee')} required error={err('assignee')}>
          <AssigneePicker
            id={ids.assignee}
            value={assignee}
            onChange={setAssignee}
            invalid={!!err('assignee')}
          />
        </FormRow>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <FormRow id={ids.priority} label={t('fields.priority')}>
          <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
            <SelectTrigger id={ids.priority} className="h-10! w-full md:text-[0.9375rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {TASK_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {TASK_PRIORITY_LABELS[p][locale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormRow>
        <FormRow id={ids.date} label={t('fields.dueDate')}>
          <Input
            id={ids.date}
            type="date"
            dir="ltr"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={NUMBER_INPUT}
          />
        </FormRow>
        <FormRow
          id={ids.time}
          label={t('fields.dueTime')}
          hint={date && !time ? t('defaultTime') : undefined}
        >
          <Input
            id={ids.time}
            type="time"
            dir="ltr"
            value={time}
            disabled={!date}
            onChange={(e) => setTime(e.target.value)}
            className={NUMBER_INPUT}
          />
        </FormRow>
      </div>
    </FormDialog>
  );
}
