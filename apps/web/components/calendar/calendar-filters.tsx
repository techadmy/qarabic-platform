'use client';

import {
  SESSION_KIND_LABELS,
  SESSION_KINDS,
  SESSION_STAGE_LABELS,
  SESSION_STAGES,
  type SessionKind,
  type SessionStage,
} from '@qarabic/shared';
import { Button } from '@qarabic/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qarabic/ui/components/select';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Combobox, MultiCombobox } from '@/components/forms/fields';
import { useUiLocale } from '@/components/sessions/times';
import { fetchLookups, fetchPeopleList } from '@/lib/api/people';
import { CALENDAR_ZONES, type CalendarState, type CalendarZone } from '@/lib/calendar/view';
import { cityOf } from '@/lib/time';

const ALL = 'all';

/**
 * The calendar's filter bar (C2, docs/42 §3.3), all in the URL: teachers and students (several),
 * course, kind, state, and the zone the times are drawn in. The teacher's (student's) zone needs
 * exactly one teacher (student) chosen; with more it is disabled and says why.
 */
export function CalendarFilters({
  state,
  onChange,
  zones,
  showTeachers = true,
  stacked = false,
}: {
  state: CalendarState;
  onChange: (patch: Partial<CalendarState>) => void;
  /** The resolved zones, for the labels: academy, mine, the one teacher's, the one student's. */
  zones: { academy: string; mine: string; teacher: string | null; student: string | null };
  /** A teacher's own calendar has no teacher filter. */
  showTeachers?: boolean;
  /** Phones: one control per row (in the «تصفية» sheet). */
  stacked?: boolean;
}) {
  const t = useTranslations('calendar.filters');
  const locale = useUiLocale();
  const lookups = useQuery({
    queryKey: ['people', 'lookups'],
    queryFn: ({ signal }) => fetchLookups(signal),
    staleTime: 5 * 60_000,
  });
  const [studentSearch, setStudentSearch] = useState('');
  const students = useQuery({
    queryKey: ['people', 'students', 'calendar-picker', studentSearch],
    queryFn: ({ signal }) =>
      fetchPeopleList('students', { q: studentSearch || undefined, perPage: 25 }, signal),
    placeholderData: keepPreviousData,
  });
  // Chosen students stay labelled while the search shows others.
  const [known, setKnown] = useState<Map<string, string>>(new Map());
  const studentOptions = [
    ...(students.data?.data ?? []).map((s) => ({ value: String(s.id), label: s.name })),
  ];
  for (const id of state.studentIds.map(String)) {
    if (!studentOptions.some((o) => o.value === id) && known.has(id)) {
      studentOptions.unshift({ value: id, label: known.get(id)! });
    }
  }
  const zoneLabel = (z: CalendarZone) => {
    const tz = z === 'academy' ? zones.academy : z === 'mine' ? zones.mine : zones[z];
    return tz ? t(`zone.${z}`, { city: cityOf(tz, locale) }) : t(`zone.${z}Unset`);
  };
  const filtered =
    state.teacherIds.length + state.studentIds.length > 0 ||
    !!state.courseId ||
    !!state.kind ||
    !!state.stage;

  return (
    <div
      role="group"
      aria-label={t('label')}
      className={stacked ? 'flex flex-col gap-3' : 'flex flex-wrap items-center gap-2'}
    >
      {showTeachers && (
        <MultiCombobox
          ariaLabel={t('teachers')}
          placeholder={t('allTeachers')}
          className="w-full bg-card sm:w-56"
          values={state.teacherIds.map(String)}
          onChange={(v) => onChange({ teacherIds: v.map(Number) })}
          options={(lookups.data?.teachers ?? []).map((p) => ({
            value: String(p.id),
            label: p.name,
          }))}
        />
      )}
      <MultiCombobox
        ariaLabel={t('students')}
        placeholder={t('allStudents')}
        className="w-full bg-card sm:w-56"
        values={state.studentIds.map(String)}
        onSearch={setStudentSearch}
        onChange={(v) => {
          const next = new Map(known);
          for (const o of studentOptions) next.set(o.value, o.label);
          setKnown(next);
          onChange({ studentIds: v.map(Number) });
        }}
        options={studentOptions}
      />
      <Combobox
        id="calendar-course"
        ariaLabel={t('course')}
        className="w-full sm:w-48"
        value={state.courseId ? String(state.courseId) : null}
        onChange={(v) => onChange({ courseId: v ? Number(v) : null })}
        options={(lookups.data?.courses ?? []).map((c) => ({
          value: String(c.id),
          label: locale === 'ar' ? c.nameAr : c.nameEn,
        }))}
        placeholder={t('allCourses')}
        searchPlaceholder={t('searchCourse')}
        clearable
      />
      <Select
        value={state.kind ?? ALL}
        onValueChange={(v) => onChange({ kind: v === ALL ? null : (v as SessionKind) })}
      >
        <SelectTrigger aria-label={t('kind')} className="h-10! w-full bg-card sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL}>{t('allKinds')}</SelectItem>
          {SESSION_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {SESSION_KIND_LABELS[k][locale]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={state.stage ?? ALL}
        onValueChange={(v) => onChange({ stage: v === ALL ? null : (v as SessionStage) })}
      >
        <SelectTrigger aria-label={t('stage')} className="h-10! w-full bg-card sm:w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL}>{t('allStages')}</SelectItem>
          {SESSION_STAGES.filter((s) => s !== 'moved_out').map((s) => (
            <SelectItem key={s} value={s}>
              {SESSION_STAGE_LABELS[s][locale]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={state.zone} onValueChange={(v) => onChange({ zone: v as CalendarZone })}>
        <SelectTrigger aria-label={t('zoneLabel')} className="h-10! w-full bg-card sm:w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {CALENDAR_ZONES.map((z) => (
            <SelectItem
              key={z}
              value={z}
              disabled={(z === 'teacher' && !zones.teacher) || (z === 'student' && !zones.student)}
            >
              {zoneLabel(z)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filtered && (
        <Button
          variant="ghost"
          className="h-10"
          onClick={() =>
            onChange({ teacherIds: [], studentIds: [], courseId: null, kind: null, stage: null })
          }
        >
          {t('clear')}
        </Button>
      )}
    </div>
  );
}
