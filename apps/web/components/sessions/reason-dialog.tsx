'use client';

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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Field, FieldError, FieldGroup, FieldLabel } from '@qarabic/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { AlertCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent, type ReactNode } from 'react';

export type ReasonResult = { text: string; choice: string };

/**
 * Confirm + reason (D31, docs/15 §5.7): the object and the consequence, the reason the rule
 * requires, a button named after the action. Destructive ones are a shadcn `AlertDialog`, the
 * others a `Dialog`; refusals show inside. Used by class actions, requests and the schedule.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  textLabel,
  textRequired,
  textMin,
  choices,
  choiceLabel,
  defaultChoice,
  extra,
  error,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  textLabel?: string;
  textRequired?: boolean;
  /** Fewest characters the reason needs (the shared `reason` rules use 3). */
  textMin?: number;
  choices?: { value: string; label: string }[];
  choiceLabel?: string;
  defaultChoice?: string;
  extra?: ReactNode;
  error?: string | null;
  busy?: boolean;
  onConfirm: (result: ReasonResult) => void;
}) {
  const t = useTranslations('classes.dialog');
  const textId = useId();
  const choiceId = useId();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState(defaultChoice ?? '');
  const [touched, setTouched] = useState(false);
  const textMissing = !!textRequired && text.trim().length === 0;
  const textShort = !textMissing && !!textMin && text.trim().length < textMin;
  const choiceMissing = !!choices && !choice;

  function change(next: boolean) {
    if (!next) {
      setText('');
      setChoice(defaultChoice ?? '');
      setTouched(false);
    }
    onOpenChange(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (textMissing || textShort || choiceMissing) return;
    onConfirm({ text: text.trim(), choice });
  }

  const body = (
    <FieldGroup>
      {choices && (
        <Field data-invalid={touched && choiceMissing}>
          <FieldLabel htmlFor={choiceId}>
            {choiceLabel}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </FieldLabel>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger
              id={choiceId}
              className="h-10! w-full"
              aria-invalid={touched && choiceMissing}
            >
              <SelectValue placeholder={t('choose')} />
            </SelectTrigger>
            <SelectContent position="popper">
              {choices.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {touched && choiceMissing && <FieldError>{t('choiceRequired')}</FieldError>}
        </Field>
      )}
      {extra}
      {textLabel && (
        <Field data-invalid={touched && (textMissing || textShort)}>
          <FieldLabel htmlFor={textId}>
            {textLabel}
            {textRequired ? (
              <span aria-hidden className="text-destructive">
                *
              </span>
            ) : (
              <span className="font-normal text-muted-foreground">({t('optional')})</span>
            )}
          </FieldLabel>
          <Textarea
            id={textId}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-required={textRequired}
            aria-invalid={touched && (textMissing || textShort)}
          />
          {touched && textMissing && <FieldError>{t('textRequired')}</FieldError>}
          {touched && textShort && <FieldError>{t('textMin', { count: textMin! })}</FieldError>}
        </Field>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
  const confirm = (
    <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={busy}>
      {busy && <Spinner />}
      {confirmLabel}
    </Button>
  );

  if (destructive) {
    return (
      <AlertDialog open={open} onOpenChange={change}>
        <AlertDialogContent className="sm:max-w-lg">
          <form noValidate onSubmit={submit} className="flex flex-col gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
            </AlertDialogHeader>
            {body}
            <AlertDialogFooter>
              <AlertDialogCancel type="button">{t('back')}</AlertDialogCancel>
              {confirm}
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {body}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('back')}
              </Button>
            </DialogClose>
            {confirm}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
