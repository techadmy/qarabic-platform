'use client';

import { archiveSchema } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Button } from '@qarabic/ui/components/button';
import { Field, FieldError, FieldLabel } from '@qarabic/ui/components/field';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { PeopleKind } from '@/lib/api/people';
import { useSchemaResolver } from '@/lib/forms/validation-messages';
import { KINDS } from '@/lib/people/kinds';
import { UNDO_MS, usePersonActions } from '@/lib/people/use-person-actions';

const KIND_KEY = {
  families: 'family',
  students: 'student',
  teachers: 'teacher',
  staff: 'staff',
} as const;

/**
 * «حذف» = archive (D128, D31): an AlertDialog stating what happens, a required reason, a
 * destructive confirm named after the action. A record still in service gets the explanation and
 * no confirm button. After archiving, an Undo toast (8 s) restores it.
 */
export function ArchiveDialog({
  kind,
  record,
  open,
  onOpenChange,
}: {
  kind: PeopleKind;
  record: { id: number; name: string; status: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('people');
  const actions = usePersonActions(kind);
  const resolver = useSchemaResolver(archiveSchema);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<{ reason: string }>({ resolver, defaultValues: { reason: '' } });
  const ready = record.status === KINDS[kind].outOfService;
  const key = KIND_KEY[kind];

  function close(next: boolean) {
    if (!next) {
      form.reset({ reason: '' });
      setServerError(null);
    }
    onOpenChange(next);
  }

  const onSubmit = form.handleSubmit(({ reason }) => {
    setServerError(null);
    actions.archive.mutate(
      { id: record.id, reason },
      {
        onSuccess: () => {
          close(false);
          toast.success(t('archive.done', { name: record.name }), {
            duration: UNDO_MS,
            action: {
              label: t('undo'),
              onClick: () =>
                void actions.restore
                  .mutateAsync({ id: record.id })
                  .then(() => toast.success(t('archive.restored', { name: record.name })))
                  .catch((e: unknown) => toast.error(actions.refusal(e))),
            },
          });
        },
        onError: (error) => setServerError(actions.refusal(error)),
      },
    );
  });

  return (
    <AlertDialog open={open} onOpenChange={close}>
      <AlertDialogContent className="sm:max-w-lg">
        <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('archive.title', { name: record.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {ready ? t(`archive.effect.${key}`) : t(`archive.deactivateFirst.${key}`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {ready && (
            <Controller
              name="reason"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="archive-reason">
                    {t('archive.reason')}
                    <span aria-hidden className="text-destructive">
                      *
                    </span>
                  </FieldLabel>
                  <Textarea
                    {...field}
                    id="archive-reason"
                    rows={3}
                    aria-required
                    aria-invalid={fieldState.invalid}
                  />
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
          <AlertDialogFooter>
            <AlertDialogCancel type="button">{ready ? t('cancel') : t('close')}</AlertDialogCancel>
            {ready && (
              <Button type="submit" variant="destructive" disabled={actions.archive.isPending}>
                {actions.archive.isPending && <Spinner />}
                {t('archive.confirm')}
              </Button>
            )}
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
