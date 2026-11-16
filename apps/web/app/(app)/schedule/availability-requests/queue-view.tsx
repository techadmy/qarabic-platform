'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@qarabic/ui/components/tabs';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-header';
import { AvailabilityChanges } from '@/components/schedule/availability-changes';
import { useCurrentUser } from '@/components/shell/app-shell';
import { ForbiddenState } from '@/components/states';
import { can } from '@/lib/auth/use-me';
import { useListParams } from '@/lib/list-params';

/**
 * «طلبات الإتاحة» (A1, docs/42 §4, B131): the staff queue of teachers' availability requests,
 * pending first; each shows what changes, from when, and the booked classes it would leave outside
 * the new hours; approve, or reject with a reason.
 */
export function AvailabilityQueueView() {
  const t = useTranslations('availability');
  const me = useCurrentUser();
  const params = useListParams();
  const all = params.get('status') === 'all';
  if (!can(me, 'schedule.view')) {
    return (
      <>
        <PageHeader title={t('queueTitle')} />
        <ForbiddenState />
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('queueTitle')} description={t('queueDescription')} />
      <Tabs
        value={all ? 'all' : 'pending'}
        onValueChange={(v) => params.set({ status: v === 'all' ? 'all' : null })}
      >
        <TabsList>
          <TabsTrigger value="pending">{t('tabs.pending')}</TabsTrigger>
          <TabsTrigger value="all">{t('tabs.all')}</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">
          <AvailabilityChanges status="pending" title={t('tabs.pending')} showTeacher />
        </TabsContent>
        <TabsContent value="all">
          <AvailabilityChanges title={t('tabs.all')} showTeacher />
        </TabsContent>
      </Tabs>
    </div>
  );
}
