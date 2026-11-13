'use client';

import {
  TRIAL_OFFER_POLICY_LABELS,
  TRIAL_OFFER_POLICIES,
  type TrialOfferPolicy,
  type TrialTeachersQuery,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Checkbox } from '@qarabic/ui/components/checkbox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@qarabic/ui/components/field';
import { RadioGroup, RadioGroupItem } from '@qarabic/ui/components/radio-group';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { Textarea } from '@qarabic/ui/components/textarea';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import { crmKeys, fetchTrialTeachers } from '@/lib/api/crm';

export interface OfferDraft {
  policy: TrialOfferPolicy;
  audience: 'eligible' | 'shortlist';
  teacherIds: number[];
  note: string;
}

export const EMPTY_OFFER: OfferDraft = {
  policy: 'first_accept',
  audience: 'eligible',
  teacherIds: [],
  note: '',
};

/**
 * The shortlist as it counts now: only teachers still eligible at the chosen time (a change of
 * time drops the others without asking).
 */
export const shortlistOf = (draft: OfferDraft, eligibleIds: number[]) =>
  draft.teacherIds.filter((id) => eligibleIds.includes(id));

/** What the CSR's offer needs before it can be sent (the error key, or null). */
export function offerProblem(draft: OfferDraft, eligibleIds: number[] | null): string | null {
  if (eligibleIds && eligibleIds.length === 0) return 'noneEligible';
  if (draft.audience === 'shortlist' && shortlistOf(draft, eligibleIds ?? []).length === 0)
    return 'shortlistEmpty';
  return null;
}

/** Stable ids, so the dialog can take the focus to the problem on send. */
export const OFFER_AUDIENCE_ID = 'trial-offer-audience';
export const OFFER_SHORTLIST_ID = 'trial-offer-shortlist';

/**
 * «اعرضها على المعلمين» (T3, docs/33 §4.3, mode B): who gets the offer (every eligible teacher, or
 * a shortlist of them, from the same ranked list as mode A), how it is decided (first to accept,
 * or volunteers then the CSR picks) and a note for the teachers. Teachers never see the family;
 * the offer closes after 2 h, and always 6 h before the class.
 */
export function TrialOfferFields({
  leadId,
  query,
  value,
  onChange,
  showErrors,
}: {
  leadId: number;
  query: TrialTeachersQuery | null;
  value: OfferDraft;
  onChange: (next: OfferDraft) => void;
  showErrors: boolean;
}) {
  const t = useTranslations('crm.trial.offer');
  const locale = useUiLocale();
  const ids = { policy: useId(), audience: useId(), note: useId(), error: useId() };
  const list = useQuery({
    queryKey: crmKeys.trialTeachers(leadId, query),
    queryFn: ({ signal }) => fetchTrialTeachers(leadId, query!, signal),
    enabled: !!query,
    placeholderData: keepPreviousData,
  });
  const eligible = list.data?.data.eligible ?? [];
  const eligibleIds = eligible.map((o) => o.teacher.id);
  const problem = offerProblem(value, list.data ? eligibleIds : null);
  const picked = shortlistOf(value, eligibleIds);
  const set = (patch: Partial<OfferDraft>) => onChange({ ...value, ...patch });

  if (!query) return <FieldDescription>{t('chooseTimeFirst')}</FieldDescription>;
  return (
    <div className="flex flex-col gap-4">
      <FieldSet>
        <FieldLegend id={ids.policy} variant="label">
          {t('policy')}
        </FieldLegend>
        <RadioGroup
          aria-labelledby={ids.policy}
          value={value.policy}
          onValueChange={(v) => set({ policy: v as TrialOfferPolicy })}
        >
          {TRIAL_OFFER_POLICIES.map((p) => (
            <FieldLabel key={p} htmlFor={`${ids.policy}-${p}`}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>{TRIAL_OFFER_POLICY_LABELS[p][locale]}</FieldTitle>
                  <FieldDescription id={`${ids.policy}-${p}-desc`}>
                    {t(`policyHelp.${p}`)}
                  </FieldDescription>
                </FieldContent>
                <RadioGroupItem
                  id={`${ids.policy}-${p}`}
                  value={p}
                  aria-label={TRIAL_OFFER_POLICY_LABELS[p][locale]}
                  aria-describedby={`${ids.policy}-${p}-desc`}
                />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet data-invalid={showErrors && !!problem}>
        <FieldLegend id={ids.audience} variant="label">
          {t('audience')}
        </FieldLegend>
        {list.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              {t('loadError')}
              <Button type="button" variant="outline" onClick={() => void list.refetch()}>
                {t('retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : !list.data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <RadioGroup
              id={OFFER_AUDIENCE_ID}
              aria-labelledby={ids.audience}
              aria-describedby={showErrors && problem ? ids.error : undefined}
              value={value.audience}
              onValueChange={(v) => set({ audience: v as OfferDraft['audience'] })}
              className="flex flex-wrap gap-x-6 gap-y-3"
            >
              {(['eligible', 'shortlist'] as const).map((a) => (
                <Field key={a} orientation="horizontal" className="w-auto">
                  <RadioGroupItem id={`${ids.audience}-${a}`} value={a} />
                  <FieldLabel htmlFor={`${ids.audience}-${a}`} className="font-normal">
                    {a === 'eligible'
                      ? t('allEligible', { count: eligible.length })
                      : t('shortlist')}
                  </FieldLabel>
                </Field>
              ))}
            </RadioGroup>
            {value.audience === 'shortlist' && (
              <FieldSet id={OFFER_SHORTLIST_ID}>
                <FieldLegend variant="label">
                  {t('shortlistLegend', { count: picked.length })}
                </FieldLegend>
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                  {eligible.map((o) => {
                    const id = `${ids.audience}-t-${o.teacher.id}`;
                    return (
                      <Field key={o.teacher.id} orientation="horizontal">
                        <Checkbox
                          id={id}
                          checked={picked.includes(o.teacher.id)}
                          onCheckedChange={(on) =>
                            set({
                              teacherIds: on
                                ? [...picked, o.teacher.id]
                                : picked.filter((x) => x !== o.teacher.id),
                            })
                          }
                        />
                        <FieldLabel htmlFor={id} className="font-normal">
                          <span className="tabular-nums text-muted-foreground">#{o.rank}</span>{' '}
                          <bdi>{o.teacher.name}</bdi>
                        </FieldLabel>
                      </Field>
                    );
                  })}
                </div>
              </FieldSet>
            )}
          </>
        )}
        {showErrors && problem && <FieldError id={ids.error}>{t(problem)}</FieldError>}
      </FieldSet>
      <Field>
        <FieldLabel htmlFor={ids.note}>
          {t('note')} <span className="font-normal text-muted-foreground">({t('optional')})</span>
        </FieldLabel>
        <Textarea
          id={ids.note}
          value={value.note}
          onChange={(e) => set({ note: e.target.value })}
          maxLength={500}
          className="min-h-20"
        />
        <FieldDescription>{t('noteHelp')}</FieldDescription>
      </Field>
      <FieldDescription>{t('expiryHelp')}</FieldDescription>
    </div>
  );
}
