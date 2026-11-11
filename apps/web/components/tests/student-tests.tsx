'use client';

import { TEST_TRACK_LABELS } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import { Skeleton } from '@qarabic/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useUiLocale } from '@/components/sessions/times';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ErrorState } from '@/components/states';
import { fetchTests, teachingKeys } from '@/lib/api/teaching';
import { can } from '@/lib/auth/use-me';
import { ScheduleTestDialog } from './schedule-test-dialog';
import { ResultSummary, TestStatusBadge, TestWhen } from './test-bits';

/**
 * «الاختبارات» on the student profile (docs/27 §8): upcoming tests in the viewer's zone with the
 * other party's labelled time, then results. A parent reads each result in place (overall and
 * section scores, mistakes in words, remarks; the API sends no cancelled tests or internal notes);
 * staff and teachers open the test, and may schedule one for this student.
 */
export function StudentTests({
  studentId,
  studentName,
}: {
  studentId: number;
  studentName: string;
}) {
  const t = useTranslations('tests');
  const locale = useUiLocale();
  const me = useCurrentUser();
  const parent = me.role?.kind === 'parent';
  const canSchedule = can(me, 'tests.manage') || can(me, 'tests.conduct');
  const [scheduling, setScheduling] = useState(false);
  const query = { studentId, perPage: 50 };
  const list = useQuery({
    queryKey: teachingKeys.testList(query),
    queryFn: ({ signal }) => fetchTests(query, signal),
  });
  const rows = list.data?.data ?? [];

  return (
    <Card className="gap-2 shadow-none lg:col-span-2" role="region" aria-labelledby="student-tests">
      <CardHeader className="border-b">
        <CardTitle id="student-tests" className="text-base font-bold">
          {t('studentTitle')}
        </CardTitle>
        {canSchedule && !parent && (
          <CardAction>
            <Button
              variant="ghost"
              size="sm"
              className="text-primary"
              onClick={() => setScheduling(true)}
            >
              <PlusIcon />
              {t('scheduleAction')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <Skeleton className="h-24" aria-busy="true" />
        ) : list.isError ? (
          <ErrorState onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <p className="py-2 text-muted-foreground">{t('studentNone')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {rows.map((test) => (
              <li key={test.id} className="flex flex-col gap-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col gap-1">
                    {parent ? (
                      <span className="font-semibold">
                        {test.status === 'scheduled'
                          ? t('upcoming', { track: TEST_TRACK_LABELS[test.track][locale] })
                          : TEST_TRACK_LABELS[test.track][locale]}
                      </span>
                    ) : (
                      <Link
                        href={`/tests/${test.id}`}
                        className="font-semibold text-primary hover:underline"
                      >
                        {TEST_TRACK_LABELS[test.track][locale]} · {test.teacher.name}
                      </Link>
                    )}
                    <TestWhen test={test} />
                  </div>
                  <span className="flex items-center gap-2">
                    {!parent && test.result && (
                      <bdi className="text-lg font-bold">{test.result.overall}%</bdi>
                    )}
                    <TestStatusBadge status={test.status} />
                  </span>
                </div>
                {parent && test.status === 'taken' && <ResultSummary test={test} />}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {scheduling && (
        <ScheduleTestDialog
          open
          onOpenChange={setScheduling}
          canPickExaminer={can(me, 'tests.manage')}
          student={{ id: studentId, name: studentName }}
        />
      )}
    </Card>
  );
}
