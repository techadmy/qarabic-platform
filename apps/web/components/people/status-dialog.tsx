'use client';

import { activeStatusChangeSchema, familyStatusChangeSchema } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
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
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { AlertCircleIcon, TriangleAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import type { PeopleKind } from '@/lib/api/people';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { KINDS, statusLabel } from '@/lib/people/kinds';
import { UNDO_MS, usePersonActions } from '@/lib/people/use-person-actions';

type FormValues = { status: string; reason?: string | null };

/**
 * «تغيير الحالة» (docs/28 §2, D31): pick the new status, read what it does, give the reason the
 * shared `*_NEEDING_REASON` lists require, confirm with a button named after the action. Refusals
 * (e.g. `teacher_has_students`) show inside the dialog. Going back to regular/active gets an Undo
 * toast (8 s).
 */
export function StatusDialog({
  kind,
  record,
  open,
  onOpenChange,
  activeStudents,
}: {
  kind: PeopleKind;
  record: { id: number; name: string; status: string; reason: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Teachers: active students (deactivation is refused while > 0). */
  activeStudents?: number;
}) {
  const t = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const config = KINDS[kind];
  const schema = kind === 'families' ? familyStatusChangeSchema : activeStatusChangeSchema;
  const resolver = useSchemaResolver(schema as never);
  const actions = usePersonActions(kind);
  const [serverError, setServerError] = useState<string | null>(null);
  const options = config.statuses.filter((s) => s !== record.status);
  const form = useForm<FormValues>({
    resolver: resolver as never,
    defaultValues: { status: options.length === 1 ? options[0]! : '', reason: '' },
  });
  const selected = useWatch({ control: form.control, name: 'status' });
  const needsReason = config.needsReason.includes(selected);
  const kindKey =
    kind === 'families'
      ? 'family'
      : kind === 'students'
        ? 'student'
        : kind === 'teachers'
          ? 'teacher'
          : 'staff';
  const blocked = kind === 'teachers' && selected === 'inactive' && (activeStudents ?? 0) > 0;

  function close(next: boolean) {
    if (!next) {
      form.reset({ status: options.length === 1 ? options[0]! : '', reason: '' });
      setServerError(null);
    }
    onOpenChange(next);
  }

  const onSubmit = form.handleSubmit((values) => {
    setServerError(null);
    const previous = { status: record.status, reason: record.reason };
    const parsed = values as unknown as { status: string; reason: string | null };
    actions.status.mutate(
      { id: record.id, status: parsed.status, reason: parsed.reason },
      {
        onSuccess: () => {
          close(false);
          const message = t('status.done', { status: statusLabel(kind, parsed.status, locale) });
          if (config.reversible.includes(parsed.status)) {
            toast.success(message, {
              duration: UNDO_MS,
              action: {
                label: t('undo'),
                // mutateAsync: the dialog may be gone (the status changed) when Undo is clicked.
                onClick: () =>
                  void actions.status
                    .mutateAsync({
                      id: record.id,
                      status: previous.status,
                      reason: config.needsReason.includes(previous.status)
                        ? (previous.reason ?? t('status.undoReason'))
                        : previous.reason,
                    })
                    .then(() => toast.success(t('status.undone')))
                    .catch((e: unknown) => toast.error(actions.refusal(e))),
              },
            });
          } else {
            toast.success(message);
          }
        },
        onError: (error) => setServerError(actions.refusal(error)),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('status.title', { name: record.name })}</DialogTitle>
            <DialogDescription>
              {t('status.current', { status: statusLabel(kind, record.status, locale) })}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Controller
              name="status"
              control={form.control}
              render={({ field, fieldState }) => (
                <FieldSet data-invalid={fieldState.invalid}>
                  <FieldLegend variant="label">{t('status.newStatus')}</FieldLegend>
                  <RadioGroup
                    name={field.name}
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      setServerError(null);
                    }}
                    aria-invalid={fieldState.invalid}
                  >
                    {options.map((s) => (
                      <Field key={s} orientation="horizontal">
                        <RadioGroupItem value={s} id={`status-${s}`} />
                        <FieldLabel htmlFor={`status-${s}`} className="font-normal">
                          {statusLabel(kind, s, locale)}
                        </FieldLabel>
                      </Field>
                    ))}
                  </RadioGroup>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </FieldSet>
              )}
            />
            {selected && (
              <Alert>
                <AlertCircleIcon />
                <AlertDescription>{t(`status.effect.${kindKey}.${selected}`)}</AlertDescription>
              </Alert>
            )}
            {blocked && (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertDescription>
                  <p>{t('status.teacherBlocked', { count: activeStudents ?? 0 })}</p>
                  <Link
                    href={`/students?teacherId=${record.id}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {t('status.viewStudents')}
                  </Link>
                </AlertDescription>
              </Alert>
            )}
            {selected && (
              <Controller
                name="reason"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="status-reason">
                      {t('status.reason')}
                      {needsReason ? (
                        <span aria-hidden className="text-destructive">
                          *
                        </span>
                      ) : (
                        <span className="font-normal text-muted-foreground">({t('optional')})</span>
                      )}
                    </FieldLabel>
                    <Textarea
                      {...field}
                      value={field.value ?? ''}
                      id="status-reason"
                      rows={3}
                      aria-required={needsReason}
                      aria-invalid={fieldState.invalid}
                    />
                    <FieldDescription>{t('status.reasonHelp')}</FieldDescription>
                    {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            )}
            {serverError && (
              <Alert variant="destructive" role="alert">
                <AlertCircleIcon />
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={actions.status.isPending}>
              {actions.status.isPending && <Spinner />}
              {selected ? t(`status.confirm.${kindKey}.${selected}`) : t('status.apply')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
