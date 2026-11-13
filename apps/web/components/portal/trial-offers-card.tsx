'use client';

import { GENDER_LABELS, type MyTrialOfferDto } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Spinner } from '@qarabic/ui/components/spinner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { toast } from 'sonner';
import { useCrmError } from '@/components/crm/crm-bits';
import { ToneBadge } from '@/components/sessions/badges';
import { useUiLocale } from '@/components/sessions/times';
import { answerMyTrialOffer, crmKeys, fetchMyTrialOffers } from '@/lib/api/crm';
import { teachingKeys } from '@/lib/api/teaching';
import { dayAndClock } from '@/lib/schedule-time';
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
  const offers = (list.data ?? []).filter((o) => o.state !== 'closed');
  if (!offers.length) return null;

  const status = (o: MyTrialOfferDto) => {
    if (o.state === 'mine') return <ToneBadge tone="green" label={t('mine')} />;
    if (o.state === 'taken') return <ToneBadge tone="grey" label={t('taken')} />;
    if (o.myResponse === 'volunteer') return <ToneBadge tone="brown" label={t('youVolunteered')} />;
    if (o.myResponse === 'decline') return <ToneBadge tone="grey" label={t('youDeclined')} />;
    return null;
  };
  const child = (o: MyTrialOfferDto) =>
    new Intl.ListFormat(locale, { type: 'unit' }).format(
      [
        o.student.gender ? GENDER_LABELS[o.student.gender][locale] : null,
        o.student.age != null ? t('age', { age: o.student.age }) : null,
      ].filter((x): x is string => !!x),
    );

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
                  {o.note && <p className="text-sm whitespace-pre-line">{o.note}</p>}
                  {o.state === 'open' && (
                    <p className="text-sm text-muted-foreground">
                      {t('answerBy', { when: dayAndClock(o.expiresAt, o.teacherZone, locale) })}
                    </p>
                  )}
                  {open && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button
                        className="h-11 md:h-10"
                        disabled={answer.isPending}
                        onClick={() => answer.mutate({ id: o.id, answer: 'accept' })}
                      >
                        {busy && answer.variables?.answer === 'accept' && <Spinner />}
                        {o.policy === 'volunteer' ? t('volunteer') : t('accept')}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11 md:h-10"
                        disabled={answer.isPending}
                        onClick={() => answer.mutate({ id: o.id, answer: 'decline' })}
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
    </section>
  );
}
