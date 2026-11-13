'use client';

import { GENDER_LABELS, type MyTrialOfferDto } from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@qarabic/ui/components/alert-dialog';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useCrmError } from '@/components/crm/crm-bits';
import { ToneBadge } from '@/components/sessions/badges';
import { useNow, useUiLocale } from '@/components/sessions/times';
import { answerMyTrialOffer, crmKeys, fetchMyTrialOffers } from '@/lib/api/crm';
import { teachingKeys } from '@/lib/api/teaching';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';
import { cityOf } from '@/lib/time';

/**
 * «عروض الحصص التجريبية» on the teacher home (T3, docs/33 §4.3): the trials offered to this
 * teacher, in their own zone, with the course, the child's age and gender and the CSR's note — no
 * family name or contacts. First-to-accept offers book at once («أقبل الحصة»); volunteer offers
 * record «أرغب في هذه الحصة» for the CSR to pick. Taken ones say so; closed ones drop off.
 */
export function TrialOffersCard() {
  const t = useTranslations('teacherPortal.offers');
  const locale = useUiLocale();
  const queryClient = useQueryClient();
  const message = useCrmError();
  const list = useQuery({
    queryKey: crmKeys.myTrialOffers,
    queryFn: ({ signal }) => fetchMyTrialOffers(signal),
    refetchInterval: 60_000,
  });
  const answer = useMutation({
    mutationFn: (v: { id: number; answer: 'accept' | 'decline' }) =>
      answerMyTrialOffer(v.id, v.answer),
    onSuccess: (o, v) => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.myTrialOffers });
      // A claimed trial is a class in the teacher's week now.
      if (o.state === 'mine')
        void queryClient.invalidateQueries({ queryKey: teachingKeys.week(undefined).slice(0, 2) });
      toast.success(
        v.answer === 'decline'
          ? t('declined')
          : o.state === 'mine'
            ? t('booked')
            : t('volunteered'),
      );
    },
    onError: (e) => {
      toast.error(message(e));
      void queryClient.invalidateQueries({ queryKey: crmKeys.myTrialOffers });
    },
  });
  const now = useNow(60_000);
  // Accepting books the class (first to accept) and declining is final: both ask first.
  const [confirming, setConfirming] = useState<{
    offer: MyTrialOfferDto;
    answer: 'accept' | 'decline';
  } | null>(null);
  if (list.isError) {
    return (
      <section aria-labelledby="home-offers" className="flex flex-col gap-2">
        <h2 id="home-offers" className="text-lg font-bold">
          {t('title')}
        </h2>
        <Alert variant="destructive" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {t('loadError')}
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      </section>
    );
  }
  const offers = (list.data ?? []).filter((o) => o.state !== 'closed');
  if (!offers.length) return null;
  const confirmText = confirming
    ? confirming.answer === 'decline'
      ? { title: t('declineTitle'), hint: t('declineHint'), action: t('decline') }
      : confirming.offer.policy === 'volunteer'
        ? { title: t('volunteerTitle'), hint: t('volunteerHint'), action: t('volunteer') }
        : { title: t('acceptTitle'), hint: t('acceptHint'), action: t('accept') }
    : null;

  const status = (o: MyTrialOfferDto) => {
    if (o.state === 'mine') return <ToneBadge tone="green" label={t('mine')} />;
    if (o.state === 'taken') return <ToneBadge tone="grey" label={t('taken')} />;
    if (o.myResponse === 'volunteer') return <ToneBadge tone="brown" label={t('youVolunteered')} />;
    if (o.myResponse === 'decline') return <ToneBadge tone="grey" label={t('youDeclined')} />;
    return null;
  };
  // «ذكر · 7 سنوات»: two facts, not a sentence.
  const child = (o: MyTrialOfferDto) =>
    [
      o.student.gender ? GENDER_LABELS[o.student.gender][locale] : null,
      o.student.age != null ? t('age', { age: o.student.age }) : null,
    ]
      .filter((x): x is string => !!x)
      .join(' · ');

  return (
    <section id="trial-offers" aria-labelledby="home-offers" className="flex flex-col gap-2">
      <h2 id="home-offers" className="text-lg font-bold">
        {t('title')}
      </h2>
      <ul className="flex flex-col gap-3">
        {offers.map((o) => {
          const open = o.state === 'open' && o.myResponse === null;
          const busy = answer.isPending && answer.variables?.id === o.id;
          return (
            <li key={o.id}>
              <Card className="gap-2 shadow-none">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold">
                    <span>{locale === 'ar' ? o.course.nameAr : o.course.nameEn}</span>
                    {status(o)}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p>
                    <bdi>{dayAndClock(o.startsAt, o.teacherZone, locale)}</bdi>{' '}
                    <span className="text-muted-foreground">
                      ({cityOf(o.teacherZone, locale)}) ·{' '}
                      {t('minutes', { count: o.durationMinutes })}
                    </span>
                  </p>
                  {child(o) && <p className="text-sm text-muted-foreground">{child(o)}</p>}
                  {o.note && (
                    <p dir="auto" className="text-sm whitespace-pre-line">
                      {o.note}
                    </p>
                  )}
                  {o.state === 'open' && (
                    <p className="text-sm text-muted-foreground">
                      {t.rich('answerBy', {
                        at: dayAndClock(o.expiresAt, o.teacherZone, locale),
                        rel: relativeTime(o.expiresAt, now, locale),
                        bdi: (c) => <bdi>{c}</bdi>,
                      })}
                    </p>
                  )}
                  {open && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        className="h-11 md:h-10"
                        disabled={answer.isPending}
                        onClick={() => setConfirming({ offer: o, answer: 'accept' })}
                      >
                        {busy && answer.variables?.answer === 'accept' && <Spinner />}
                        {o.policy === 'volunteer' ? t('volunteer') : t('accept')}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11 md:h-10"
                        disabled={answer.isPending}
                        onClick={() => setConfirming({ offer: o, answer: 'decline' })}
                      >
                        {t('decline')}
                      </Button>
                    </div>
                  )}
                  {o.state === 'mine' && o.sessionId && (
                    <Button variant="link" asChild className="h-11 self-start px-0 md:h-10">
                      <Link href={`/my-classes?session=${o.sessionId}`}>{t('openClass')}</Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
      <AlertDialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming &&
                t('confirmWhat', {
                  course:
                    locale === 'ar'
                      ? confirming.offer.course.nameAr
                      : confirming.offer.course.nameEn,
                  when: dayAndClock(
                    confirming.offer.startsAt,
                    confirming.offer.teacherZone,
                    locale,
                  ),
                })}{' '}
              {confirmText?.hint}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming?.answer === 'decline' ? 'destructive' : 'default'}
              onClick={() => {
                if (confirming)
                  answer.mutate({ id: confirming.offer.id, answer: confirming.answer });
                setConfirming(null);
              }}
            >
              {confirmText?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
