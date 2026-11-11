import {
  affectedManualSessionsSchema,
  availabilitySchema,
  conflictResultSchema,
  enrollmentDetailSchema,
  enrollmentListResponseSchema,
  enrollmentSchema,
  holidaySchema,
  scheduleSlotSchema,
  teacherBlockSchema,
  timetableSchema,
  workHourSchema,
  type AddSlotInput,
  type AvailabilityDto,
  type AvailabilityQuery,
  type ConflictResultDto,
  type CreateEnrollmentInput,
  type CreateHolidayInput,
  type CreateTeacherBlockInput,
  type EndEnrollmentInput,
  type EndSlotInput,
  type EnrollmentDetailDto,
  type EnrollmentDto,
  type EnrollmentListQuery,
  type HolidayDto,
  type Paginated,
  type PauseEnrollmentInput,
  type ReplaceWorkHoursInput,
  type ScheduleCheckInput,
  type ScheduleSlotDto,
  type SessionDto,
  type TeacherBlockDto,
  type TimetableDto,
  type TimetableQuery,
  type UpdateEnrollmentInput,
  type UpdateHolidayInput,
  type UpdateSlotInput,
  type UpdateTeacherBlockInput,
  type WorkHourDto,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Schedule endpoints (N2): enrollments, weekly slots, availability, the conflict check, holidays,
 * teacher timetable, blocks and work hours. Every answer is parsed with the `@qarabic/shared`
 * schema (apps/api/README.md, N2).
 */
type Query = Record<string, string | number | boolean | undefined>;
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const withAffected = <T extends z.ZodType>(schema: T) =>
  z.object({ data: schema, affectedManualSessions: affectedManualSessionsSchema });

export type Affected<T> = { data: T; affectedManualSessions: SessionDto[] };

export async function fetchEnrollments(
  query: EnrollmentListQuery & Query,
  signal?: AbortSignal,
): Promise<Paginated<EnrollmentDto>> {
  const qs = toSearchParams(query);
  return apiFetch(`/enrollments${qs ? `?${qs}` : ''}`, {
    schema: enrollmentListResponseSchema,
    signal,
  });
}

export async function fetchEnrollment(id: number, signal?: AbortSignal) {
  return (await apiFetch(`/enrollments/${id}`, { schema: one(enrollmentDetailSchema), signal }))
    .data as EnrollmentDetailDto;
}

export async function createEnrollment(body: CreateEnrollmentInput): Promise<EnrollmentDto> {
  return (await apiFetch('/enrollments', { method: 'POST', body, schema: one(enrollmentSchema) }))
    .data;
}

export async function updateEnrollment(
  id: number,
  body: UpdateEnrollmentInput,
): Promise<Affected<EnrollmentDto>> {
  return apiFetch(`/enrollments/${id}`, {
    method: 'PATCH',
    body,
    schema: withAffected(enrollmentSchema),
  });
}

export async function enrollmentLifecycle(
  id: number,
  action: 'pause' | 'resume' | 'end',
  body: PauseEnrollmentInput | EndEnrollmentInput | Record<string, never> = {},
): Promise<EnrollmentDto> {
  return (
    await apiFetch(`/enrollments/${id}/${action}`, {
      method: 'POST',
      body,
      schema: one(enrollmentSchema),
    })
  ).data;
}

export async function addSlot(enrollmentId: number, body: AddSlotInput): Promise<ScheduleSlotDto> {
  return (
    await apiFetch(`/enrollments/${enrollmentId}/slots`, {
      method: 'POST',
      body,
      schema: one(scheduleSlotSchema),
    })
  ).data;
}

export async function updateSlot(
  id: number,
  body: UpdateSlotInput,
): Promise<Affected<ScheduleSlotDto>> {
  return apiFetch(`/schedule-slots/${id}`, {
    method: 'PATCH',
    body,
    schema: withAffected(scheduleSlotSchema),
  });
}

export async function endSlot(id: number, body: EndSlotInput): Promise<ScheduleSlotDto> {
  return (
    await apiFetch(`/schedule-slots/${id}/end`, {
      method: 'POST',
      body,
      schema: one(scheduleSlotSchema),
    })
  ).data;
}

export async function checkSchedule(body: ScheduleCheckInput, signal?: AbortSignal) {
  return (
    await apiFetch('/schedule/check', {
      method: 'POST',
      body,
      schema: one(conflictResultSchema),
      signal,
    })
  ).data as ConflictResultDto;
}

export async function fetchAvailability(
  query: AvailabilityQuery,
  signal?: AbortSignal,
): Promise<AvailabilityDto> {
  const { weekdays, teacherIds, ...rest } = query;
  const qs = toSearchParams({
    ...(rest as Query),
    weekdays: Array.isArray(weekdays) ? weekdays.join(',') : (weekdays as string | undefined),
    teacherIds: Array.isArray(teacherIds) ? teacherIds.join(',') : undefined,
  });
  return (
    await apiFetch(`/schedule/availability?${qs}`, { schema: one(availabilitySchema), signal })
  ).data;
}

export async function fetchTimetable(
  teacherId: number,
  query: TimetableQuery = {},
  signal?: AbortSignal,
): Promise<TimetableDto> {
  const qs = toSearchParams(query as Query);
  return (
    await apiFetch(`/teachers/${teacherId}/timetable${qs ? `?${qs}` : ''}`, {
      schema: one(timetableSchema),
      signal,
    })
  ).data;
}

export async function fetchBlocks(teacherId: number, signal?: AbortSignal) {
  return (
    await apiFetch(`/teachers/${teacherId}/blocks`, {
      schema: one(z.array(teacherBlockSchema)),
      signal,
    })
  ).data as TeacherBlockDto[];
}

export async function createBlock(teacherId: number, body: CreateTeacherBlockInput) {
  return (
    await apiFetch(`/teachers/${teacherId}/blocks`, {
      method: 'POST',
      body,
      schema: one(teacherBlockSchema),
    })
  ).data as TeacherBlockDto;
}

export async function updateBlock(
  teacherId: number,
  blockId: number,
  body: UpdateTeacherBlockInput,
) {
  return (
    await apiFetch(`/teachers/${teacherId}/blocks/${blockId}`, {
      method: 'PATCH',
      body,
      schema: one(teacherBlockSchema),
    })
  ).data as TeacherBlockDto;
}

export async function deleteBlock(teacherId: number, blockId: number): Promise<void> {
  await apiFetch(`/teachers/${teacherId}/blocks/${blockId}`, { method: 'DELETE' });
}

export async function fetchWorkHours(teacherId: number, signal?: AbortSignal) {
  return (
    await apiFetch(`/teachers/${teacherId}/work-hours`, {
      schema: one(z.array(workHourSchema)),
      signal,
    })
  ).data as WorkHourDto[];
}

export async function replaceWorkHours(teacherId: number, body: ReplaceWorkHoursInput) {
  return (
    await apiFetch(`/teachers/${teacherId}/work-hours`, {
      method: 'PUT',
      body,
      schema: one(z.array(workHourSchema)),
    })
  ).data as WorkHourDto[];
}

export async function fetchHolidays(year: number, signal?: AbortSignal): Promise<HolidayDto[]> {
  return (await apiFetch(`/holidays?year=${year}`, { schema: one(z.array(holidaySchema)), signal }))
    .data;
}

export async function createHoliday(body: CreateHolidayInput): Promise<HolidayDto> {
  return (await apiFetch('/holidays', { method: 'POST', body, schema: one(holidaySchema) })).data;
}

export async function updateHoliday(id: number, body: UpdateHolidayInput): Promise<HolidayDto> {
  return (await apiFetch(`/holidays/${id}`, { method: 'PATCH', body, schema: one(holidaySchema) }))
    .data;
}

export async function deleteHoliday(id: number): Promise<void> {
  await apiFetch(`/holidays/${id}`, { method: 'DELETE' });
}

/** React Query keys of the N2 screens. */
export const scheduleKeys = {
  all: ['schedule'] as const,
  enrollments: (query: unknown) => ['schedule', 'enrollments', query] as const,
  enrollment: (id: number) => ['schedule', 'enrollment', id] as const,
  timetable: (teacherId: number, query: unknown) =>
    ['schedule', 'timetable', teacherId, query] as const,
  blocks: (teacherId: number) => ['schedule', 'blocks', teacherId] as const,
  workHours: (teacherId: number) => ['schedule', 'work-hours', teacherId] as const,
  holidays: (year: number) => ['schedule', 'holidays', year] as const,
  availability: (query: unknown) => ['schedule', 'availability', query] as const,
  check: (input: unknown) => ['schedule', 'check', input] as const,
};
