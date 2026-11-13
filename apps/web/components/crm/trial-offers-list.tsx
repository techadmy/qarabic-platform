'use client';

import {
  TRIAL_OFFER_POLICY_LABELS,
  TRIAL_OFFER_RESPONSE_LABELS,
  TRIAL_OFFER_STATUS_LABELS,
  type ConflictResultDto,
  type TrialOfferDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@qarabic/ui/components/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { ToneBadge } from '@/components/sessions/badges';
import { canSave, ConflictList } from '@/components/sessions/conflict-list';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { BothClassTimes, useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { crmKeys, fetchLeadTrialOffers, trialOfferAction } from '@/lib/api/crm';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import { conflictsOf } from '@/lib/sessions/errors';
import { useCrmError } from './crm-bits';

const TONE = { open: 'brown', claimed: 'green', expired: 'red', cancelled: 'grey' } as const;

/**
 * The lead's open offers (T3, docs/33 §4.3) above its trial classes: status, deadline, who it
 * went to and what each teacher answered. Volunteers can be picked («اختر»); an open or expired
 * offer can be re-sent or cancelled. Nothing here is shown when the lead has no offers.
 */
export function TrialOffersList({ leadId, canManage }: { leadId: number; canManage: boolean }) {
  const t = useTranslations('crm.offers');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const list = useQuery({
    queryKey: crmKeys.trialOffers(leadId),
    queryFn: ({ signal }) => fetchLeadTrialOffers(leadId, signal),
  });
  const now = useNow(60_000);
  // «اختر» a volunteer: the booking's own check answers; warnings come back to be acknowledged.
  const [picking, setPicking] = useState<{
    offerId: number;
    teacher: { id: number; name: string };
    result: ConflictResultDto;
    ack: string[];
  } | null>(null);
  const [cancelling, setCancelling] = useState<TrialOfferDto | null>(null);
  const act = useMutation({
    mutationFn: (v: {
      id: number;
      action: 'assign' | 'resend' | 'cancel';
      teacher?: { id: number; name: string };
      ack?: string[];
      reason?: string;
    }) =>
      trialOfferAction(
        v.id,
        v.action,
        v.action === 'assign'
          ? { teacherId: v.teacher!.id, acknowledgeWarnings: v.ack ?? [] }
          : v.action === 'cancel'
            ? { reason: v.reason ?? null }
            : {},
      ),
    onSuccess: (_, v) => {
      setPicking(null);
      setCancelling(null);
      void queryClient.invalidateQueries({ queryKey: crmKeys.trialOffers(leadId) });
      void queryClient.invalidateQueries({ queryKey: crmKeys.lead(leadId) });
      toast.success(t(`done.${v.action}`));
    },
    onError: (e, v) => {
      const result = v.action === 'assign' ? conflictsOf(e) : null;
      if (result && v.teacher) {
        setPicking({ offerId: v.id, teacher: v.teacher, result, ack: v.ack ?? [] });
        return;
      }
      if (v.action !== 'cancel') toast.error(message(e));
    },
  });
  const when = (iso: string) =>
    t.rich('when', {
      at: dayAndClock(iso, tz, locale),
      rel: relativeTime(iso, now, locale),
      bdi: (c) => <bdi>{c}</bdi>,
    });
  if (list.isError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          {t('loadError')}
          <Button variant="outline" onClick={() => void list.refetch()}>
            {t('retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const offers = list.data ?? [];
  if (!offers.length) return null;

  const row = (o: TrialOfferDto) => {
    const live = o.status === 'open' || o.status === 'expired';
    return (
      <li key={o.id}>
        <Card className="gap-2 shadow-none">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold">
              <span>
                {t('title', { course: locale === 'ar' ? o.course.nameAr : o.course.nameEn })}
              </span>
              <ToneBadge
                tone={TONE[o.status]}
                label={TRIAL_OFFER_STATUS_LABELS[o.status][locale]}
              />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BothClassTimes at={o.startsAt} otherTz={o.familyZone} party="student" />
            <p className="text-sm text-muted-foreground">
              {TRIAL_OFFER_POLICY_LABELS[o.policy][locale]}
              {' · '}
              {o.status === 'open' ? (
                <>
                  {t('closes')} {when(o.expiresAt)}
                </>
              ) : o.claimedTeacher ? (
                t('claimedBy', { name: o.claimedTeacher.name })
              ) : (
                <>
                  {t('closed')} {when(o.closedAt ?? o.expiresAt)}
                </>
              )}
            </p>
            <ul className="flex flex-col divide-y rounded-lg border" aria-label={t('teachers')}>
              {o.teachers.map((x) => (
                <li
                  key={x.teacher.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="flex items-center gap-2">
                    {x.rank != null && (
                      <span className="text-sm tabular-nums text-muted-foreground">#{x.rank}</span>
                    )}
                    <bdi>{x.teacher.name}</bdi>
                    <span className="text-sm text-muted-foreground">
                      {x.response ? TRIAL_OFFER_RESPONSE_LABELS[x.response][locale] : t('noAnswer')}
                    </span>
                  </span>
                  {canManage && o.status === 'open' && x.response === 'volunteer' && (
                    <Button
                      size="sm"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ id: o.id, action: 'assign', teacher: x.teacher })}
                    >
                      {t('pick')}
                      <span className="sr-only">: {x.teacher.name}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {canManage && live && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: o.id, action: 'resend' })}
                >
                  {act.isPending && act.variables?.action === 'resend' && <Spinner />}
                  {t('resend')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={act.isPending}
                  onClick={() => {
                    act.reset();
                    setCancelling(o);
                  }}
                >
                  {t('cancel')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </li>
    );
  };

  return (
    <section aria-labelledby="lead-offers" className="flex flex-col gap-3">
      <h3 id="lead-offers" className="font-bold">
        {t('heading')}
      </h3>
      <ul className="flex flex-col gap-3">{offers.map(row)}</ul>
      <ReasonDialog
        open={!!cancelling}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t('cancelTitle')}
        description={t('cancelHint')}
        confirmLabel={t('cancel')}
        destructive
        textLabel={t('cancelReason')}
        textRequired
        textMin={3}
        busy={act.isPending}
        error={act.isError && act.variables?.action === 'cancel' ? message(act.error) : null}
        onConfirm={({ text }) =>
          cancelling && act.mutate({ id: cancelling.id, action: 'cancel', reason: text })
        }
      />
      <Dialog open={!!picking} onOpenChange={(open) => !open && setPicking(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{picking && t('pickTitle', { name: picking.teacher.name })}</DialogTitle>
            <DialogDescription>{t('pickHint')}</DialogDescription>
          </DialogHeader>
          {picking && (
            <ConflictList
              result={picking.result}
              acknowledged={picking.ack}
              onAcknowledge={(ack) => setPicking({ ...picking, ack })}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPicking(null)}>
              {t('back')}
            </Button>
            <Button
              disabled={!picking || !canSave(picking.result, picking.ack) || act.isPending}
              onClick={() =>
                picking &&
                act.mutate({
                  id: picking.offerId,
                  action: 'assign',
                  teacher: picking.teacher,
                  ack: picking.ack,
                })
              }
            >
              {act.isPending && <Spinner />}
              {t('pickConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
