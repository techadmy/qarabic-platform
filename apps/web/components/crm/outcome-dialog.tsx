'use client';

import {
  LOST_REASON_LABELS,
  LOST_REASONS,
  SESSION_STAGE_LABELS,
  TRIAL_OUTCOME_LABELS,
  TRIAL_OUTCOMES,
  type LeadDetailDto,
  type LostReason,
  type SessionStage,
  type TrialOutcome,
} from '@qarabic/shared';
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
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@qarabic/ui/components/field';
import { Label } from '@qarabic/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { Spinner } from '@qarabic/ui/components/spinner';
import { Textarea } from '@qarabic/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { useUiLocale } from '@/components/sessions/times';
import { recordTrialOutcome } from '@/lib/api/crm';
import { useDirection } from '@/lib/use-direction';
import { useCrmError } from './crm-bits';

/**
 * «سجّل نتيجة التجريبية» (docs/26 §9.5): interested → بعد التجريبية, no-show → back to تم التواصل,
 * not interested → غير مهتم with the reason (cancels a still-booked trial).
 */
export function OutcomeDialog({
  lead,
  onClose,
  onSaved,
}: {
  lead: LeadDetailDto;
  onClose: () => void;
  onSaved: (l: LeadDetailDto) => void;
}) {
  const t = useTranslations('crm.outcome');
  const tc = useTranslations('crm');
  const locale = useUiLocale();
  const dir = useDirection();
  const message = useCrmError();
  const noteId = useId();
  const reasonId = useId();
  const [outcome, setOutcome] = useState<TrialOutcome | ''>('');
  const [reason, setReason] = useState<LostReason>('not_interested');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      recordTrialOutcome(lead.id, {
        outcome: outcome as TrialOutcome,
        note: note.trim() || null,
        lostReason: outcome === 'not_interested' ? reason : null,
      }),
    onSuccess: (d) => {
      toast.success(t('saved'));
      onSaved(d);
      onClose();
    },
  });
  const trial = lead.trials[0];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (outcome) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>
              {trial
                ? t('hint', {
                    student: trial.student.name,
                    stage:
                      SESSION_STAGE_LABELS[trial.stage as SessionStage]?.[locale] ?? trial.stage,
                  })
                : lead.parentName}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <FieldSet data-invalid={touched && !outcome}>
              <FieldLegend variant="label">{t('choice')}</FieldLegend>
              <RadioGroup
                dir={dir}
                value={outcome}
                onValueChange={(v) => setOutcome(v as TrialOutcome)}
                aria-invalid={touched && !outcome}
              >
                {TRIAL_OUTCOMES.map((o) => (
                  <div key={o} className="flex items-center gap-2">
                    <RadioGroupItem value={o} id={`outcome-${o}`} />
                    <Label htmlFor={`outcome-${o}`} className="font-normal">
                      {TRIAL_OUTCOME_LABELS[o][locale]}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              {touched && !outcome && <FieldError>{t('choiceRequired')}</FieldError>}
            </FieldSet>
            {outcome === 'not_interested' && (
              <Field>
                <FieldLabel htmlFor={reasonId}>{tc('confirm.reason')}</FieldLabel>
                <Select value={reason} onValueChange={(v) => setReason(v as LostReason)}>
                  <SelectTrigger id={reasonId} className="h-10! w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {LOST_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {LOST_REASON_LABELS[r][locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={noteId}>
                {t('note')}{' '}
                <span className="font-normal text-muted-foreground">({tc('optional')})</span>
              </FieldLabel>
              <Textarea
                id={noteId}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {save.isError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{message(save.error)}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tc('back')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
