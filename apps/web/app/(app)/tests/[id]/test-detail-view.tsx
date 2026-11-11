'use client';

import {
  TEST_RECORD_LEAD_MINUTES,
  TEST_SECTION_LABELS,
  TEST_TRACK_LABELS,
  type TestDto,
} from '@qarabic/shared';
import { Alert, AlertDescription } from '@qarabic/ui/components/alert';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardXIcon, ClockIcon, PencilIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { InfoSection, ProfileSkeleton } from '@/components/people/detail';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/sessions/reason-dialog';
import { useNow, useUiLocale, useViewerTz } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState, ErrorState, ForbiddenState } from '@/components/states';
import { ResultForm } from '@/components/tests/result-form';
import {
  ResultSummary,
  TestStatusBadge,
  TestWhen,
  useTestError,
} from '@/components/tests/test-bits';
import { isApiError } from '@/lib/api/client';
import { decideTest, fetchTest, teachingKeys, type TestDecision } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { dayAndClock, relativeTime } from '@/lib/schedule-time';

/**
 * One test (docs/27 §8; the current app's `TestPage`): who and when (both zones), the status and
 * the actions the viewer may do (`can`): record / correct the result, refuse, cancel, reopen —
 * each of the last three confirmed with a reason (D31, D117). The result form for the examiner or
 * staff, else the read-only result.
 */
export function TestDetailView({ id }: { id: number }) {
  const t = useTranslations('tests');
  const locale = useUiLocale();
  const tz = useViewerTz();
  const now = useNow(30_000);
  const me = useCurrentUser();
  const staff = can(me, 'tests.manage');
  const queryClient = useQueryClient();
  const message = useTestError();
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState<TestDecision | null>(null);
  const query = useQuery({
    queryKey: teachingKeys.test(id),
    queryFn: ({ signal }) => fetchTest(id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const decide = useMutation({
    mutationFn: (v: { act: TestDecision; reason: string }) => decideTest(id, v.act, v.reason),
    onSuccess: (next, v) => {
      queryClient.setQueryData(teachingKeys.test(id), next);
      void queryClient.invalidateQueries({ queryKey: teachingKeys.all });
      toast.success(t(`act.done.${v.act}`));
      setActing(null);
    },
  });
  const back = { href: '/tests', label: t('back') };

  if (!can(me, 'tests.view')) return <ForbiddenState />;
  if (isApiError(query.error, 404)) {
    return (
      <>
        <PageHeader back={back} title={t('notFoundTitle')} />
        <EmptyState
          icon={ClipboardXIcon}
          role="alert"
          title={t('notFoundTitle')}
          description={t('notFound')}
        />
      </>
    );
  }
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;
  if (query.isPending) return <ProfileSkeleton />;
  const test: TestDto = query.data;
  const showForm = test.can.record || (editing && test.can.editResult);
  const opensAt = Date.parse(test.scheduledAt) - TEST_RECORD_LEAD_MINUTES * 60_000;
  const waiting =
    test.status === 'scheduled' && !test.can.record && test.can.update && opensAt > now.getTime();
  const until = test.result?.editableUntil;

  return (
    <>
      <PageHeader
        back={back}
        title={t('detailTitle', { name: test.student.name })}
        meta={`${TEST_TRACK_LABELS[test.track][locale]} · ${t('examinerIs', { name: test.teacher.name })}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TestStatusBadge status={test.status} />
            {test.can.reopen && (
              <Button variant="outline" onClick={() => setActing('reopen')}>
                {t('act.reopen')}
              </Button>
            )}
            {test.can.cancel && (
              <Button variant="outline" onClick={() => setActing('cancel')}>
                {t('act.cancel')}
              </Button>
            )}
            {test.can.refuse && (
              <Button
                variant="outline"
                className="text-red-700 dark:text-red-400"
                onClick={() => setActing('refuse')}
              >
                {t('act.refuse')}
              </Button>
            )}
          </div>
        }
      />
      <InfoSection
        title={t('detail.section')}
        rows={[
          { label: t('detail.when'), value: <TestWhen test={test} /> },
          { label: t('detail.duration'), value: t('minutes', { count: test.durationMinutes }) },
          { label: t('detail.examiner'), value: test.teacher.name },
          {
            label: t('detail.sections'),
            value: test.sections.map((s) => TEST_SECTION_LABELS[s][locale]).join('، '),
          },
          ...(test.course
            ? [
                {
                  label: t('detail.course'),
                  value: locale === 'ar' ? test.course.nameAr : test.course.nameEn,
                },
              ]
            : []),
          ...(test.notes ? [{ label: t('detail.notes'), value: test.notes }] : []),
          ...(test.statusReason
            ? [{ label: t('detail.reason'), value: <bdi>{test.statusReason}</bdi> }]
            : []),
        ]}
      />
      <Card className="gap-2 shadow-none">
        <CardHeader className="border-b">
          <CardTitle className="text-base font-bold">
            {test.can.record ? t('result.record') : t('result.title')}
          </CardTitle>
          {test.can.editResult && !editing && test.result && (
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                onClick={() => setEditing(true)}
              >
                <PencilIcon />
                {t('result.edit')}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {until && test.can.editResult && !staff && (
            <Alert>
              <ClockIcon />
              <AlertDescription>
                {t('result.editableUntil', {
                  time: dayAndClock(until, tz, locale),
                  ago: relativeTime(until, now, locale),
                })}
              </AlertDescription>
            </Alert>
          )}
          {showForm ? (
            <ResultForm
              key={`${test.id}-${test.status}`}
              test={test}
              staff={staff}
              onDone={() => setEditing(false)}
              onCancel={editing ? () => setEditing(false) : undefined}
            />
          ) : test.result ? (
            <ResultSummary test={test} />
          ) : waiting ? (
            <p className="text-muted-foreground">
              {t('result.opensAt', {
                time: dayAndClock(new Date(opensAt).toISOString(), tz, locale),
              })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t('result.pending')}</p>
          )}
        </CardContent>
      </Card>
      {acting && (
        <ReasonDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              decide.reset();
              setActing(null);
            }
          }}
          destructive={acting !== 'reopen'}
          title={t(`act.${acting}Title`, { name: test.student.name })}
          description={t(`act.${acting}Body`)}
          confirmLabel={t(`act.${acting}`)}
          textLabel={t('act.reason')}
          textRequired
          textMin={3}
          busy={decide.isPending}
          error={decide.isError ? message(decide.error) : null}
          onConfirm={(r) => decide.mutate({ act: acting, reason: r.text })}
        />
      )}
    </>
  );
}
