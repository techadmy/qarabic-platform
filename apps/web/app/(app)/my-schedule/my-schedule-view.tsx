'use client';

import { CalendarXIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCurrentUser } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/states';
import { TimetableView } from '../teachers/[id]/timetable/timetable-view';

/**
 * «جدولي» (teacher portal, N2 leftover): the teacher's own timetable and work hours from
 * `me.teacherId` — the same screen staff open from the teacher's profile, with the work hours
 * editable by the teacher (`PUT /teachers/:id/work-hours` allows their own).
 */
export function MyScheduleView() {
  const t = useTranslations('teacherPortal');
  const me = useCurrentUser();
  if (!me.teacherId) {
    return (
      <EmptyState icon={CalendarXIcon} title={t('noTeacherTitle')} description={t('noTeacher')} />
    );
  }
  return <TimetableView id={me.teacherId} mine />;
}
