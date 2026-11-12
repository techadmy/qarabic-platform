'use client';

import {
  createTaskSchema,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  updateTaskSchema,
  type TaskDetailDto,
  type TaskPriority,
  type TaskSubjectType,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { Controller, useForm, type Control } from 'react-hook-form';
import { toast } from 'sonner';
import { DatePicker, TimeSelect } from '@/components/forms/date-time';
import { SelectField, TextareaField, TextField } from '@/components/forms/fields';
import { FormDialog } from '@/components/payroll/payroll-bits';
import { useUiLocale, useViewerTz } from '@/components/sessions/times';
import { createTask, fetchTaskTemplates, operationsKeys, updateTask } from '@/lib/api/operations';
import { applyServerErrors } from '@/lib/forms/server-errors';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { dueInstant, splitInstant } from '@/lib/operations/time';
import { addDays, dateKeyIn } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';
import { AssigneePicker, useOperationsError } from './ops-bits';

/** The task form: the body of `POST /tasks` (shared `createTaskSchema`), due as an ISO instant. */
type Values = {
  title: string;
  description: string | null;
  assigneeId: number | null;
  priority: TaskPriority;
  dueAt: string | null;
  templateId?: number;
  subjectType?: TaskSubjectType | null;
  subjectId?: number | null;
};
const FIELDS = ['title', 'description', 'assigneeId', 'priority', 'dueAt'];
const NONE = '__none__';

/**
 * The due time: a date (shadcn DatePicker) and a time every 15 minutes, both in the viewer's zone
 * and labelled with it (D30); clearing the date removes the due time.
 */
export function DueAtField<T extends { dueAt: string | null }>({
  control,
  label,
}: {
  control: Control<T>;
  label: string;
}) {
  const t = useTranslations('operations.tasks');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const dateId = useId();
  const timeId = useId();
  return (
    <Controller
      control={control as unknown as Control<{ dueAt: string | null }>}
      name="dueAt"
      render={({ field, fieldState }) => {
        const { date, time } = splitInstant(field.value, tz);
        const set = (d: string, tm: string) => field.onChange(dueInstant(d, tm, tz));
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={dateId}>{label}</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
              <DatePicker id={dateId} value={date} onChange={(d) => set(d, time)} />
              <TimeSelect
                id={timeId}
                label={t('fields.dueTime', { city: cityOf(tz, locale) })}
                value={time}
                onChange={(tm) => set(date || dateKeyIn(tz), tm)}
              />
              {date && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label={t('clearDue')}
                  onClick={() => field.onChange(null)}
                >
                  <XIcon />
                </Button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {t('dueHint', { city: cityOf(tz, locale) })}
            </p>
            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
          </Field>
        );
      }}
    />
  );
}

/**
 * «مهمة جديدة» / «تعديل المهمة» (M8, old Given / Issued tasks): title, details, who does it,
 * priority and the due time in the viewer's zone; a template fills the title, details, priority
 * and due date. `subject` links the task to a record (from that record's page). Validated with
 * the shared schemas; a 422 lands on its field.
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
  subject?: { type: TaskSubjectType; id: number; label: string };
}) {
  const t = useTranslations('operations.tasks');
  const tv = useTranslations('validation');
  const tf = useTranslations('form');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const router = useRouter();
  const queryClient = useQueryClient();
  const message = useOperationsError();
  const ids = { template: useId(), assignee: useId() };
  const [banner, setBanner] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const resolver = useSchemaResolver(task ? updateTaskSchema : createTaskSchema);
  const form = useForm<Values>({
    resolver: resolver as never,
    mode: 'onTouched',
    defaultValues: {
      title: task?.title ?? '',
      description: task?.description ?? null,
      assigneeId: task?.assignee.id ?? null,
      priority: task?.priority ?? 'normal',
      dueAt: task?.dueAt ?? null,
      ...(subject ? { subjectType: subject.type, subjectId: subject.id } : {}),
    },
  });
  const [assignee, setAssignee] = useState<{ id: number; name: string } | null>(
    task?.assignee ?? null,
  );
  const templates = useQuery({
    queryKey: operationsKeys.templates,
    queryFn: ({ signal }) => fetchTaskTemplates(signal),
    enabled: open && !task,
  });
  const save = useMutation({
    mutationFn: (v: Values) =>
      task
        ? updateTask(task.id, {
            title: v.title,
            description: v.description,
            priority: v.priority,
            dueAt: v.dueAt,
          })
        : createTask({
            ...v,
            assigneeId: v.assigneeId!,
            ...(templateId ? { templateId } : {}),
          }),
    onSuccess: (x) => {
      void queryClient.invalidateQueries({ queryKey: operationsKeys.all });
      toast.success(task ? t('saved') : t('created', { name: x.assignee.name }));
      onOpenChange(false);
      if (!task) router.push(`/tasks/${x.id}`);
    },
    onError: (e) => {
      if (!applyServerErrors(form, e, (k) => tv(k), FIELDS)) setBanner(message(e));
    },
  });
  const submit = form.handleSubmit(
    (v) => {
      setBanner(null);
      save.mutate(v);
    },
    () => setBanner(null),
  );

  function applyTemplate(v: string) {
    const tpl = templates.data?.find((x) => String(x.id) === v);
    setTemplateId(tpl?.id ?? null);
    if (!tpl) return;
    const opts = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
    form.setValue('title', tpl.title, opts);
    form.setValue('description', tpl.description, opts);
    form.setValue('priority', tpl.priority, opts);
    if (tpl.dueInDays !== null) {
      form.setValue('dueAt', dueInstant(addDays(dateKeyIn(tz), tpl.dueInDays), '', tz), opts);
    }
  }

  const c = form.control as unknown as Control<Values>;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={task ? t('editTitle') : t('newTitle')}
      description={subject ? t('aboutSubject', { label: subject.label }) : undefined}
      submitLabel={task ? t('save') : t('create')}
      busy={save.isPending}
      error={banner}
      summary={Object.keys(form.formState.errors).length ? t('form.fixErrors') : null}
      onSubmit={() => void submit()}
    >
      {!task && (templates.data?.length ?? 0) > 0 && (
        <Field>
          <FieldLabel htmlFor={ids.template}>{t('template')}</FieldLabel>
          <Select value={templateId ? String(templateId) : NONE} onValueChange={applyTemplate}>
            <SelectTrigger id={ids.template} className="h-10! w-full">
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
          <p className="text-sm text-muted-foreground">{t('templateHint')}</p>
        </Field>
      )}
      <TextField control={c} name="title" label={t('fields.title')} required />
      <TextareaField control={c} name="description" label={t('fields.description')} rows={3} />
      {!task && (
        <Controller
          control={c}
          name="assigneeId"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={ids.assignee}>
                {t('fields.assignee')}
                <span className="text-destructive" aria-label={tf('required')}>
                  *
                </span>
              </FieldLabel>
              <AssigneePicker
                id={ids.assignee}
                value={assignee}
                onChange={(p) => {
                  setAssignee(p);
                  field.onChange(p?.id ?? null);
                }}
                invalid={fieldState.invalid}
              />
              {fieldState.invalid && <FieldError>{t('form.assigneeRequired')}</FieldError>}
            </Field>
          )}
        />
      )}
      <SelectField
        control={c}
        name="priority"
        label={t('fields.priority')}
        options={TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABELS[p][locale] }))}
      />
      <DueAtField control={c} label={t('fields.due')} />
    </FormDialog>
  );
}
