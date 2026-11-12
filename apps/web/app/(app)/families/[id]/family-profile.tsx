'use client';

import { useRecordPane } from '@/components/list/split-view';
import { cn } from '@qarabic/ui/lib/utils';
import { countryName } from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@qarabic/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@qarabic/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { InfoSection, KeyFacts, StatusHistory } from '@/components/people/detail';
import { BothTimes } from '@/components/people/local-time';
import { ProfileShell } from '@/components/people/profile-shell';
import { useCurrentUser } from '@/components/shell/app-shell';
import { StatusBadge } from '@/components/status-badge';
import { fetchPerson } from '@/lib/api/people';
import { can } from '@/lib/auth/use-me';
import { peopleKeys } from '@/lib/people/use-person-actions';
import { formatDate, formatInstant, zoneLabel } from '@/lib/time';
import { ProfileSchedule } from '@/components/schedule/profile-schedule';
import { FamilyBillingSection } from '@/components/billing/family-billing';
import { useListParams } from '@/lib/list-params';
import { useDirection } from '@/lib/use-direction';

const TABS = ['overview', 'schedule', 'billing', 'history'] as const;
type Tab = (typeof TABS)[number];

/**
 * Family profile (K6, docs/28 §5): header + key facts + titled sections + children + history, and
 * for staff who see invoices the «الفوترة» sections (N6, docs/20 §12).
 * D141 §7: tabs at the top (نظرة عامة / الجدول / الفوترة / السجل, in `?tab=`) and collapsible
 * sections inside «نظرة عامة».
 */
export function FamilyProfile({ id, mine = false }: { id: number; mine?: boolean }) {
  const pane = useRecordPane();
  const t = useTranslations('families');
  const tp = useTranslations('people');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const canManage = can(me, 'families.manage');
  const query = useQuery({
    queryKey: peopleKeys.detail('families', id),
    queryFn: ({ signal }) => fetchPerson('families', id, signal),
    enabled: Number.isInteger(id) && id > 0,
  });
  const f = query.data;
  const params = useListParams();
  const dir = useDirection();
  const showSchedule = !!f && !f.archive;
  const showBilling = !mine && can(me, 'invoices.view');
  const showHistory = !mine;
  const shown = TABS.filter(
    (k) =>
      k === 'overview' ||
      (k === 'schedule' && showSchedule) ||
      (k === 'billing' && showBilling) ||
      (k === 'history' && showHistory),
  );
  const raw = params.get('tab') as Tab;
  const tab: Tab = shown.includes(raw) ? raw : 'overview';

  return (
    <ProfileShell
      kind="families"
      backHref={mine ? undefined : '/families'}
      backLabel={t('back')}
      query={query}
      canManage={canManage}
      record={
        f && {
          id: f.id,
          name: f.parentName,
          subtitle: <bdi dir="ltr">{f.email}</bdi>,
          status: f.status,
          archive: f.archive,
        }
      }
      sheetTarget={f && { kind: 'families', record: f }}
      addStudentFor={f?.id}
    >
      {({ edit }) =>
        f && (
          <>
            <KeyFacts
              items={[
                { label: tp('fields.students'), value: f.students.length },
                {
                  label: tp('fields.status'),
                  value: <StatusBadge kind="families" status={f.status.value} />,
                },
                {
                  label: tp('fields.localTime'),
                  value: (
                    <span className="text-sm font-medium">
                      <BothTimes timeZone={f.timezone} party={tp('party.family')} />
                    </span>
                  ),
                },
                { label: tp('fields.manager'), value: f.manager?.name ?? '—' },
              ]}
            />
            <Tabs
              dir={dir}
              value={tab}
              onValueChange={(v) =>
                params.set({ tab: v === 'overview' ? null : v }, { resetPage: false })
              }
            >
              <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
                {shown.map((k) => (
                  <TabsTrigger key={k} value={k}>
                    {t(`tabs.${k}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="mt-2">
                <div
                  className={cn(
                    'grid items-start gap-4',
                    // In the split view's pane the columns follow the pane (D141 §1).
                    pane ? '@5xl:grid-cols-2' : 'lg:grid-cols-2',
                  )}
                >
                  <InfoSection
                    collapsible
                    title={tp('sections.contact')}
                    onEdit={canManage && !f.archive ? () => edit('contact') : undefined}
                    rows={[
                      { label: tp('fields.parent'), value: f.parentName },
                      { label: tp('fields.email'), value: <bdi dir="ltr">{f.email}</bdi> },
                      {
                        label: tp('fields.phone'),
                        value: f.phone && <bdi dir="ltr">{f.phone}</bdi>,
                      },
                      {
                        label: tp('fields.country'),
                        value: f.countryCode && countryName(f.countryCode, locale),
                      },
                      { label: tp('fields.timezone'), value: zoneLabel(f.timezone, locale) },
                    ]}
                  />
                  <Card className="gap-2 shadow-none">
                    <CardHeader className="border-b">
                      <CardTitle className="text-base font-bold">
                        {t('children', { count: f.students.length })}
                      </CardTitle>
                      {canManage && !f.archive && (
                        <CardAction>
                          <Button variant="ghost" size="sm" className="text-primary" asChild>
                            <Link href={`/students?familyId=${f.id}`}>{t('viewInStudents')}</Link>
                          </Button>
                        </CardAction>
                      )}
                    </CardHeader>
                    <CardContent>
                      {f.students.length === 0 ? (
                        <p className="py-2 text-muted-foreground">{t('noChildren')}</p>
                      ) : (
                        <Table aria-label={t('childrenTable')}>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead>{tp('fields.name')}</TableHead>
                              <TableHead>{tp('fields.status')}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {f.students.map((s) => (
                              <TableRow key={s.id}>
                                <TableCell>
                                  <Link
                                    href={`/students/${s.id}`}
                                    className="font-semibold text-primary hover:underline"
                                  >
                                    {s.name}
                                  </Link>
                                </TableCell>
                                <TableCell>
                                  <StatusBadge kind="students" status={s.status} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>
                  <InfoSection
                    collapsible
                    title={tp('sections.account')}
                    onEdit={canManage && !f.archive ? () => edit('account') : undefined}
                    rows={[
                      { label: tp('fields.manager'), value: f.manager?.name },
                      {
                        label: tp('fields.createdAt'),
                        value: formatInstant(f.createdAt, me.timezone, locale),
                      },
                      ...(mine
                        ? []
                        : [{ label: tp('fields.comment'), value: f.comment, wide: true }]),
                    ]}
                  />
                  <InfoSection
                    collapsible
                    title={tp('sections.dates')}
                    onEdit={canManage && !f.archive ? () => edit('dates') : undefined}
                    rows={[
                      { label: tp('fields.startDate'), value: formatDate(f.startDate, locale) },
                      { label: tp('fields.trialDate'), value: formatDate(f.trialDate, locale) },
                    ]}
                  />
                  <InfoSection
                    collapsible
                    title={tp('sections.online')}
                    onEdit={canManage && !f.archive ? () => edit('online') : undefined}
                    rows={[
                      {
                        label: tp('fields.zoomId'),
                        value: f.zoomId && <bdi dir="ltr">{f.zoomId}</bdi>,
                      },
                      {
                        label: tp('fields.whatsappGroupId'),
                        value: f.whatsappGroupId && <bdi dir="ltr">{f.whatsappGroupId}</bdi>,
                      },
                    ]}
                  />
                </div>
              </TabsContent>
              {showSchedule && (
                <TabsContent value="schedule" className="mt-2">
                  <ProfileSchedule studentIds={f.students.map((c) => c.id)} />
                </TabsContent>
              )}
              {showBilling && (
                <TabsContent value="billing" className="mt-2">
                  <FamilyBillingSection familyId={f.id} />
                </TabsContent>
              )}
              {showHistory && (
                <TabsContent value="history" className="mt-2">
                  <StatusHistory kind="families" entries={f.statusHistory} />
                </TabsContent>
              )}
            </Tabs>
          </>
        )
      }
    </ProfileShell>
  );
}
