import {
  lessonReportSchema,
  progressSchema,
  reportListResponseSchema,
  sessionSchema,
  teacherStudentsSchema,
  teacherWeekSchema,
  testListResponseSchema,
  testSchema,
  testSummarySchema,
  type CreateTestInput,
  type LessonReportDto,
  type LessonReportInput,
  type Paginated,
  type ProgressDto,
  type RecordTestResultInput,
  type ReportListItemDto,
  type ReportListQuery,
  type SessionDto,
  type TeacherStudentDto,
  type TeacherWeekDto,
  type TestDto,
  type TestListQuery,
  type TestSummaryDto,
  type UpdateTestInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';
import { toSearchParams } from './people';

/**
 * Teaching endpoints (N3): the lesson report of a class, the staff reports list, a student's
 * progress, student tests and the teacher portal («أسبوعي», «طلابي»). Every answer is parsed with
 * its `@qarabic/shared` schema.
 */
type Query = Record<string, string | number | boolean | undefined>;
const one = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
const list = (v: unknown) => (Array.isArray(v) ? v.join(',') : (v as string | undefined));

// ------------------------------------------------------------------ lesson reports

export async function fetchReport(
  sessionId: number,
  signal?: AbortSignal,
): Promise<LessonReportDto | null> {
  return (
    await apiFetch(`/sessions/${sessionId}/report`, {
      schema: one(lessonReportSchema.nullable()),
      signal,
    })
  ).data;
}

/** `PUT /sessions/:id/report`: `ended` → `taken`, or an edit of a taken class; answers the class. */
export async function submitReport(
  sessionId: number,
  body: LessonReportInput,
): Promise<SessionDto> {
  return (
    await apiFetch(`/sessions/${sessionId}/report`, {
      method: 'PUT',
      body,
      schema: one(sessionSchema),
    })
  ).data;
}

export async function fetchLessonReports(
  query: ReportListQuery,
  signal?: AbortSignal,
): Promise<Paginated<ReportListItemDto>> {
  const { state, ...rest } = query;
  const qs = toSearchParams({ ...(rest as Query), state: list(state) });
  return apiFetch(`/lesson-reports${qs ? `?${qs}` : ''}`, {
    schema: reportListResponseSchema,
    signal,
  });
}

// ------------------------------------------------------------------ progress

export async function fetchProgress(studentId: number, signal?: AbortSignal): Promise<ProgressDto> {
  return (
    await apiFetch(`/students/${studentId}/progress`, { schema: one(progressSchema), signal })
  ).data;
}

// ------------------------------------------------------------------ tests

export async function fetchTests(
  query: TestListQuery,
  signal?: AbortSignal,
): Promise<Paginated<TestDto>> {
  const { status, ...rest } = query;
  const qs = toSearchParams({ ...(rest as Query), status: list(status) });
  return apiFetch(`/tests${qs ? `?${qs}` : ''}`, { schema: testListResponseSchema, signal });
}

export async function fetchTestSummary(
  month: string,
  signal?: AbortSignal,
): Promise<TestSummaryDto> {
  return (
    await apiFetch(`/tests/summary?month=${month}`, { schema: one(testSummarySchema), signal })
  ).data;
}

export async function fetchTest(id: number, signal?: AbortSignal): Promise<TestDto> {
  return (await apiFetch(`/tests/${id}`, { schema: one(testSchema), signal })).data;
}

export async function createTest(body: CreateTestInput): Promise<TestDto> {
  return (await apiFetch('/tests', { method: 'POST', body, schema: one(testSchema) })).data;
}

export async function updateTest(id: number, body: UpdateTestInput): Promise<TestDto> {
  return (await apiFetch(`/tests/${id}`, { method: 'PATCH', body, schema: one(testSchema) })).data;
}

export async function recordTestResult(id: number, body: RecordTestResultInput): Promise<TestDto> {
  return (await apiFetch(`/tests/${id}/result`, { method: 'PUT', body, schema: one(testSchema) }))
    .data;
}

export type TestDecision = 'refuse' | 'cancel' | 'reopen';

export async function decideTest(id: number, act: TestDecision, reason: string): Promise<TestDto> {
  return (
    await apiFetch(`/tests/${id}/${act}`, {
      method: 'POST',
      body: { reason },
      schema: one(testSchema),
    })
  ).data;
}

// ------------------------------------------------------------------ teacher portal

export async function fetchTeacherWeek(
  date: string | undefined,
  signal?: AbortSignal,
): Promise<TeacherWeekDto> {
  const qs = date ? `?date=${date}` : '';
  return (await apiFetch(`/teacher-portal/week${qs}`, { schema: one(teacherWeekSchema), signal }))
    .data;
}

export async function fetchTeacherStudents(signal?: AbortSignal): Promise<TeacherStudentDto[]> {
  return (
    await apiFetch('/teacher-portal/students', { schema: one(teacherStudentsSchema), signal })
  ).data;
}

/**
 * Query keys. The class-shaped ones live under `sessions` so a class write (`upsertSession`)
 * refreshes the week, the reports list and the board together.
 */
export const teachingKeys = {
  all: ['teaching'] as const,
  report: (sessionId: number) => ['sessions', 'report', sessionId] as const,
  reports: (query: unknown) => ['sessions', 'lesson-reports', query] as const,
  week: (date: string | undefined) => ['sessions', 'teacher-week', date ?? 'today'] as const,
  myStudents: ['sessions', 'teacher-students'] as const,
  progress: (studentId: number) => ['teaching', 'progress', studentId] as const,
  tests: ['teaching', 'tests'] as const,
  testList: (query: unknown) => ['teaching', 'tests', 'list', query] as const,
  testSummary: (month: string) => ['teaching', 'tests', 'summary', month] as const,
  test: (id: number) => ['teaching', 'tests', 'detail', id] as const,
};
