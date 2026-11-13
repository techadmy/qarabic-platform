import {
  ACTIVE_STATUSES,
  activeStatusChangeSchema,
  archiveSchema,
  createFamilySchema,
  createStaffSchema,
  createStudentSchema,
  createTeacherSchema,
  FAMILY_STATUSES,
  familyListQuerySchema,
  familyStatusChangeSchema,
  staffListQuerySchema,
  studentListQuerySchema,
  teacherListQuerySchema,
  updateFamilySchema,
  updateStaffSchema,
  updateStudentSchema,
  updateTeacherSchema,
  type FamilyDetailDto,
  type StaffDto,
  type StudentDetailDto,
  type TeacherDetailDto,
} from '@qarabic/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { z } from 'zod';
import { MOCK_ROLES, type MockUser } from './data';
import { COUNTRIES, COURSES, db, syncDerived, type StaffRow } from './people-db';
import { apiError, guard, guardAny, notFound, validationFailed } from './session';

/**
 * MSW handlers for the N1 People endpoints, same contract as apps/api/README.md: list queries
 * parsed with the shared schemas, `{ data, meta: { …, counts } }`, the row scopes (a teacher's own
 * students without parent data, a parent's own family) and the business refusals.
 */
const API = '*/api/v1';
const NOW = () => new Date().toISOString();
const ref = (me: MockUser) => ({ id: me.id, name: me.name });

type AnyRow = FamilyDetailDto | StudentDetailDto | TeacherDetailDto | StaffRow;

function isTeacherViewer(me: MockUser) {
  return me.role?.kind === 'teacher';
}
function isParentViewer(me: MockUser) {
  return me.role?.kind === 'parent';
}
function teacherIdOf(me: MockUser) {
  return db.teachers.find((t) => t.userId === me.id)?.id ?? -1;
}

function includes(text: string | null | undefined, q: string) {
  return !!text && text.toLowerCase().includes(q);
}
function phoneMatch(phone: string | null | undefined, q: string) {
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 && !!phone && phone.replace(/\D/g, '').includes(digits);
}

function paginate<T extends AnyRow>(
  all: T[],
  q: { page: number; perPage: number; status?: string },
  statuses: readonly string[],
  sorter: (a: T, b: T) => number,
) {
  const counts: Record<string, number> = { all: all.length };
  for (const s of statuses) counts[s] = all.filter((r) => r.status.value === s).length;
  const rows = (q.status ? all.filter((r) => r.status.value === q.status) : all).sort(sorter);
  const total = rows.length;
  const start = (q.page - 1) * q.perPage;
  return {
    data: rows.slice(start, start + q.perPage),
    meta: {
      page: q.page,
      perPage: q.perPage,
      total,
      lastPage: Math.max(1, Math.ceil(total / q.perPage)),
      counts,
    },
  };
}

function compare(order: 'asc' | 'desc', a: string | number, b: string | number) {
  const result =
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return order === 'asc' ? result : -result;
}

function queryOf(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams);
}

/** Students as a teacher sees them (D138): no email, no parent name. */
function forViewer(student: StudentDetailDto, me: MockUser): StudentDetailDto {
  if (!isTeacherViewer(me)) return student;
  const { email: _email, family, ...rest } = student;
  return {
    ...rest,
    family: { id: family.id, countryCode: family.countryCode, timezone: family.timezone },
    statusHistory: [],
  };
}

function familyForViewer(family: FamilyDetailDto, me: MockUser): FamilyDetailDto {
  return isParentViewer(me) ? { ...family, comment: null, statusHistory: [] } : family;
}

const staffDto = (row: StaffRow): StaffDto => {
  const { statusHistory: _h, ...rest } = row;
  return rest;
};

function findRole(name: string) {
  return MOCK_ROLES.find((r) => r.name === name && (r.kind === 'owner' || r.kind === 'staff'));
}

function emailTaken(email: string, exceptUserId?: number) {
  const lower = email.toLowerCase();
  return (
    db.families.some((f) => f.email === lower && f.parentUserId !== exceptUserId) ||
    db.teachers.some((t) => t.email === lower && t.userId !== exceptUserId) ||
    db.staff.some((s) => s.email === lower && s.id !== exceptUserId)
  );
}
const takenError = () =>
  apiError(422, 'validation_failed', 'The given data was invalid.', {
    email: ['The email has already been taken.'],
  });

async function body(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function changeStatusOn(
  row: AnyRow,
  next: { status: string; reason: string | null },
  me: MockUser,
) {
  row.statusHistory.unshift({
    from: row.status.value,
    to: next.status,
    reason: next.reason,
    at: NOW(),
    by: ref(me),
  });
  row.status = {
    value: next.status as never,
    reason: next.reason,
    changedAt: NOW(),
    changedBy: ref(me),
  };
}

function setArchive(row: AnyRow, reason: string | null, me: MockUser) {
  row.archive = reason === null ? null : { archivedAt: NOW(), reason, by: ref(me) };
}

/** Status change, archive and restore for one record type. */
function lifecycle<T extends AnyRow>(
  path: string,
  options: {
    manage: string;
    rows: () => T[];
    schema: typeof familyStatusChangeSchema | typeof activeStatusChangeSchema;
    outOfService: string;
    show: (row: T, me: MockUser) => unknown;
    refuseStatus?: (row: T, next: string, me: MockUser) => Response | null;
    refuseArchive?: (row: T, me: MockUser) => Response | null;
    refuseRestore?: (row: T) => Response | null;
    afterArchive?: (row: T, archived: boolean, me: MockUser) => void;
  },
): HttpHandler[] {
  const find = (id: string) => options.rows().find((r) => r.id === Number(id));
  return [
    http.post(`${API}/${path}/:id/status`, async ({ request, params }) => {
      const g = guard(request, options.manage);
      if ('error' in g) return g.error;
      const row = find(params.id as string);
      if (!row) return notFound();
      if (row.archive) return apiError(409, 'archived', 'The record is archived.');
      const parsed = options.schema.safeParse(await body(request));
      if (!parsed.success) return validationFailed(parsed.error.issues);
      if (parsed.data.status === row.status.value) {
        return apiError(422, 'same_status', 'The record already has this status.');
      }
      const refusal = options.refuseStatus?.(row, parsed.data.status, g.me);
      if (refusal) return refusal;
      changeStatusOn(row, parsed.data, g.me);
      syncDerived(db);
      return HttpResponse.json({ data: options.show(row, g.me) });
    }),
    http.delete(`${API}/${path}/:id`, async ({ request, params }) => {
      const g = guard(request, options.manage);
      if ('error' in g) return g.error;
      const row = find(params.id as string);
      if (!row) return notFound();
      const parsed = archiveSchema.safeParse(await body(request));
      if (!parsed.success) return validationFailed(parsed.error.issues);
      if (row.archive) return apiError(409, 'archived', 'The record is already archived.');
      if (row.status.value !== options.outOfService) {
        return apiError(409, 'must_deactivate_first', 'Deactivate the record first.');
      }
      const refusal = options.refuseArchive?.(row, g.me);
      if (refusal) return refusal;
      setArchive(row, parsed.data.reason, g.me);
      options.afterArchive?.(row, true, g.me);
      syncDerived(db);
      return HttpResponse.json({ data: options.show(row, g.me) });
    }),
    http.post(`${API}/${path}/:id/restore`, ({ request, params }) => {
      const g = guard(request, options.manage);
      if ('error' in g) return g.error;
      const row = find(params.id as string);
      if (!row) return notFound();
      if (!row.archive) return apiError(409, 'not_archived', 'The record is not archived.');
      const refusal = options.refuseRestore?.(row);
      if (refusal) return refusal;
      setArchive(row, null, g.me);
      options.afterArchive?.(row, false, g.me);
      syncDerived(db);
      return HttpResponse.json({ data: options.show(row, g.me) });
    }),
  ];
}

type FamilyOut = z.output<typeof createFamilySchema>;

export const peopleHandlers: HttpHandler[] = [
  http.get(`${API}/people/lookups`, ({ request }) => {
    const g = guardAny(request, 'families.manage', 'staff.manage', 'users.manage');
    if ('error' in g) return g.error;
    const isOwner = g.me.role?.kind === 'owner';
    return HttpResponse.json({
      data: {
        countries: COUNTRIES,
        courses: COURSES,
        managers: db.staff
          .filter(
            (s) =>
              s.status.value === 'active' &&
              !s.archive &&
              ['admin', 'manager', 'csr', 'custom_10'].includes(s.role.name),
          )
          .map((s) => ({ id: s.id, name: s.name })),
        teachers: db.teachers
          .filter((t) => t.status.value === 'active' && !t.archive)
          .map((t) => ({ id: t.id, name: t.name })),
        staffRoles: MOCK_ROLES.filter(
          (r) => r.kind === 'staff' || (r.kind === 'owner' && isOwner),
        ).map((r) => ({
          id: r.id,
          name: r.name,
          labelAr: r.labelAr,
          labelEn: r.labelEn,
          kind: r.kind,
        })),
        payCurrencies: ['EGP'],
        defaultPayCurrency: 'EGP',
      },
    });
  }),

  // ------------------------------------------------------------------ families
  http.get(`${API}/families`, ({ request }) => {
    const g = guard(request, 'families.view');
    if ('error' in g) return g.error;
    const parsed = familyListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const term = q.q?.toLowerCase() ?? '';
    const rows = db.families.filter((f) => {
      if (!!f.archive !== q.archived) return false;
      if (isParentViewer(g.me) && f.parentUserId !== g.me.id) return false;
      if (q.managerId && f.manager?.id !== q.managerId) return false;
      if (q.countryCode && f.countryCode !== q.countryCode) return false;
      if (!term) return true;
      return (
        includes(f.parentName, term) ||
        includes(f.email, term) ||
        phoneMatch(f.phone, term) ||
        String(f.id) === term ||
        f.students.some((s) => includes(s.name, term))
      );
    });
    const order = q.order ?? (q.sort === 'parentName' ? 'asc' : 'desc');
    const key = (f: FamilyDetailDto) =>
      q.sort === 'parentName'
        ? f.parentName
        : q.sort === 'startDate'
          ? (f.startDate ?? '')
          : q.sort === 'createdAt'
            ? f.createdAt
            : f.id;
    const page = paginate(rows, q, FAMILY_STATUSES, (a, b) => compare(order, key(a), key(b)));
    return HttpResponse.json({
      data: page.data.map((f) => {
        const { statusHistory: _h, ...rest } = familyForViewer(f, g.me);
        return rest;
      }),
      meta: page.meta,
    });
  }),

  http.get(`${API}/families/:id`, ({ request, params }) => {
    const g = guard(request, 'families.view');
    if ('error' in g) return g.error;
    const family = db.families.find((f) => f.id === Number(params.id));
    if (!family || (isParentViewer(g.me) && family.parentUserId !== g.me.id)) return notFound();
    return HttpResponse.json({ data: familyForViewer(family, g.me) });
  }),

  http.post(`${API}/families`, async ({ request }) => {
    const g = guard(request, 'families.manage');
    if ('error' in g) return g.error;
    const parsed = createFamilySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input: FamilyOut = parsed.data;
    if (emailTaken(input.email)) return takenError();
    const id = db.nextId.families++;
    const manager = input.managerId ? db.staff.find((s) => s.id === input.managerId) : null;
    const family: FamilyDetailDto = {
      id,
      parentUserId: 1000 + id,
      parentName: input.parentName,
      email: input.email,
      phone: input.phone,
      countryCode: input.countryCode ?? null,
      timezone: input.timezone,
      manager: manager ? { id: manager.id, name: manager.name } : null,
      startDate: input.startDate ?? null,
      trialDate: input.trialDate ?? null,
      zoomId: input.zoomId ?? null,
      whatsappGroupId: input.whatsappGroupId ?? null,
      comment: input.comment ?? null,
      status: { value: input.status, reason: null, changedAt: null, changedBy: null },
      archive: null,
      students: [],
      createdAt: NOW(),
      statusHistory: [],
    };
    db.families.push(family);
    return HttpResponse.json({ data: family }, { status: 201 });
  }),

  http.patch(`${API}/families/:id`, async ({ request, params }) => {
    const g = guard(request, 'families.manage');
    if ('error' in g) return g.error;
    const family = db.families.find((f) => f.id === Number(params.id));
    if (!family) return notFound();
    if (family.archive) return apiError(409, 'archived', 'The record is archived.');
    const parsed = updateFamilySchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (input.email && emailTaken(input.email, family.parentUserId)) return takenError();
    const { managerId, status: _status, ...rest } = input;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (family as unknown as Record<string, unknown>)[key] = value;
    }
    if (managerId !== undefined) {
      const manager = managerId ? db.staff.find((s) => s.id === managerId) : null;
      family.manager = manager ? { id: manager.id, name: manager.name } : null;
    }
    syncDerived(db);
    return HttpResponse.json({ data: family });
  }),

  ...lifecycle('families', {
    manage: 'families.manage',
    rows: () => db.families,
    schema: familyStatusChangeSchema,
    outOfService: 'deactivated',
    show: (f, me) => familyForViewer(f, me),
    afterArchive: (family, archived, me) => {
      for (const s of db.students.filter((x) => x.familyId === family.id)) {
        if (archived && !s.archive) setArchive(s, family.archive?.reason ?? null, me);
        if (!archived && s.archive) setArchive(s, null, me);
      }
    },
  }),

  // ------------------------------------------------------------------ students
  http.get(`${API}/students`, ({ request }) => {
    const g = guardAny(request, 'families.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const parsed = studentListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const term = q.q?.toLowerCase() ?? '';
    const teacherScope = isTeacherViewer(g.me) ? teacherIdOf(g.me) : null;
    const parentFamily = isParentViewer(g.me)
      ? db.families.find((f) => f.parentUserId === g.me.id)?.id
      : null;
    const rows = db.students.filter((s) => {
      if (!!s.archive !== q.archived) return false;
      if (teacherScope !== null && s.teacher?.id !== teacherScope) return false;
      if (parentFamily !== null && parentFamily !== undefined && s.familyId !== parentFamily)
        return false;
      if (q.familyId && s.familyId !== q.familyId) return false;
      if (q.teacherId && s.teacher?.id !== q.teacherId) return false;
      if (q.courseId && s.regularCourse?.id !== q.courseId && s.additionalCourse?.id !== q.courseId)
        return false;
      if (!term) return true;
      const family = db.families.find((f) => f.id === s.familyId);
      return (
        includes(s.name, term) ||
        String(s.id) === term ||
        (teacherScope === null &&
          (includes(s.email, term) ||
            includes(family?.parentName, term) ||
            includes(family?.email, term) ||
            phoneMatch(family?.phone, term)))
      );
    });
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const key = (s: StudentDetailDto) =>
      q.sort === 'name' ? s.name : q.sort === 'createdAt' ? s.createdAt : s.id;
    const page = paginate(rows, q, ACTIVE_STATUSES, (a, b) => compare(order, key(a), key(b)));
    return HttpResponse.json({
      data: page.data.map((s) => {
        const { statusHistory: _h, ...rest } = forViewer(s, g.me);
        return rest;
      }),
      meta: page.meta,
    });
  }),

  http.get(`${API}/students/:id`, ({ request, params }) => {
    const g = guardAny(request, 'families.view', 'sessions.conduct');
    if ('error' in g) return g.error;
    const s = db.students.find((x) => x.id === Number(params.id));
    if (!s) return notFound();
    if (isTeacherViewer(g.me) && s.teacher?.id !== teacherIdOf(g.me)) return notFound();
    if (
      isParentViewer(g.me) &&
      db.families.find((f) => f.id === s.familyId)?.parentUserId !== g.me.id
    )
      return notFound();
    return HttpResponse.json({ data: forViewer(s, g.me) });
  }),

  http.post(`${API}/students`, async ({ request }) => {
    const g = guard(request, 'families.manage');
    if ('error' in g) return g.error;
    const parsed = createStudentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const family = db.families.find((f) => f.id === input.familyId);
    if (!family || family.archive || family.status.value === 'deactivated') {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        familyId: ['The selected family is invalid.'],
      });
    }
    const teacher = input.teacherId ? db.teachers.find((t) => t.id === input.teacherId) : null;
    if (input.teacherId && (!teacher || teacher.status.value !== 'active')) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        teacherId: ['The selected teacher is invalid.'],
      });
    }
    const student: StudentDetailDto = {
      id: db.nextId.students++,
      familyId: family.id,
      family: {
        id: family.id,
        parentName: family.parentName,
        countryCode: family.countryCode,
        timezone: family.timezone,
      },
      name: input.name,
      email: input.email ?? null,
      gender: input.gender ?? null,
      age: input.age ?? null,
      language: input.language ?? null,
      regularCourse: input.regularCourseId
        ? (COURSES.filter((c) => c.id === input.regularCourseId).map(({ id, nameAr, nameEn }) => ({
            id,
            nameAr,
            nameEn,
          }))[0] ?? null)
        : null,
      additionalCourse: input.additionalCourseId
        ? (COURSES.filter((c) => c.id === input.additionalCourseId).map(
            ({ id, nameAr, nameEn }) => ({ id, nameAr, nameEn }),
          )[0] ?? null)
        : null,
      teacher: teacher ? { id: teacher.id, name: teacher.name } : null,
      startDate: input.startDate ?? null,
      zoomId: input.zoomId ?? null,
      remarkParent: input.remarkParent ?? null,
      remarkTeacher: input.remarkTeacher ?? null,
      status: { value: 'active', reason: null, changedAt: null, changedBy: null },
      archive: null,
      createdAt: NOW(),
      statusHistory: [],
    };
    db.students.push(student);
    syncDerived(db);
    return HttpResponse.json({ data: student }, { status: 201 });
  }),

  http.patch(`${API}/students/:id`, async ({ request, params }) => {
    const g = guard(request, 'families.manage');
    if ('error' in g) return g.error;
    const s = db.students.find((x) => x.id === Number(params.id));
    if (!s) return notFound();
    if (s.archive) return apiError(409, 'archived', 'The record is archived.');
    const parsed = updateStudentSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { regularCourseId, additionalCourseId, teacherId, familyId, ...rest } = parsed.data;
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (s as unknown as Record<string, unknown>)[key] = value;
    }
    const course = (id: number | null) => {
      const c = COURSES.find((x) => x.id === id);
      return c ? { id: c.id, nameAr: c.nameAr, nameEn: c.nameEn } : null;
    };
    if (regularCourseId !== undefined) s.regularCourse = course(regularCourseId);
    if (additionalCourseId !== undefined) s.additionalCourse = course(additionalCourseId);
    if (teacherId !== undefined) {
      const t = teacherId ? db.teachers.find((x) => x.id === teacherId) : null;
      s.teacher = t ? { id: t.id, name: t.name } : null;
    }
    if (familyId !== undefined) s.familyId = familyId;
    syncDerived(db);
    return HttpResponse.json({ data: s });
  }),

  ...lifecycle('students', {
    manage: 'families.manage',
    rows: () => db.students,
    schema: activeStatusChangeSchema,
    outOfService: 'inactive',
    show: (s, me) => forViewer(s, me),
    refuseRestore: (s) =>
      db.families.find((f) => f.id === s.familyId)?.archive
        ? apiError(409, 'family_archived', 'Restore the family first.')
        : null,
  }),

  // ------------------------------------------------------------------ teachers
  http.get(`${API}/teachers`, ({ request }) => {
    const g = guard(request, 'staff.view');
    if ('error' in g) return g.error;
    const parsed = teacherListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const term = q.q?.toLowerCase() ?? '';
    const rows = db.teachers.filter((t) => {
      if (!!t.archive !== q.archived) return false;
      if (q.courseId && !t.courses.some((c) => c.id === q.courseId)) return false;
      if (!term) return true;
      return (
        includes(t.name, term) ||
        includes(t.email, term) ||
        phoneMatch(t.phone, term) ||
        String(t.id) === term
      );
    });
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const key = (t: TeacherDetailDto) =>
      q.sort === 'name' ? t.name : q.sort === 'createdAt' ? t.createdAt : t.id;
    const page = paginate(rows, q, ACTIVE_STATUSES, (a, b) => compare(order, key(a), key(b)));
    return HttpResponse.json({
      data: page.data.map(({ statusHistory: _h, ...t }) => t),
      meta: page.meta,
    });
  }),

  http.get(`${API}/teachers/:id`, ({ request, params }) => {
    const g = guard(request, 'staff.view');
    if ('error' in g) return g.error;
    const t = db.teachers.find((x) => x.id === Number(params.id));
    return t ? HttpResponse.json({ data: t }) : notFound();
  }),

  http.post(`${API}/teachers`, async ({ request }) => {
    const g = guard(request, 'staff.manage');
    if ('error' in g) return g.error;
    const parsed = createTeacherSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    if (emailTaken(input.email)) return takenError();
    const id = db.nextId.teachers++;
    const teacher: TeacherDetailDto = {
      id,
      userId: 3000 + id,
      firstName: input.firstName,
      lastName: input.lastName ?? null,
      name: [input.firstName, input.lastName].filter(Boolean).join(' '),
      email: input.email,
      phone: input.phone,
      altPhone: input.altPhone ?? null,
      gender: input.gender ?? null,
      nationality: input.nationality ?? null,
      countryCode: input.countryCode ?? null,
      timezone: input.timezone,
      age: input.age ?? null,
      hourlyRate: input.hourlyRate ?? null,
      hourlyRateCurrency: 'EGP',
      courses: COURSES.filter((c) => input.courseIds?.includes(c.id)).map(
        ({ id: cid, nameAr, nameEn }) => ({ id: cid, nameAr, nameEn }),
      ),
      acceptsTrials: input.acceptsTrials ?? true,
      maxTrialsPerWeek: input.maxTrialsPerWeek ?? null,
      audience: input.audience ?? 'both',
      languages: input.languages ?? [],
      qualification: input.qualification ?? null,
      experience: input.experience ?? null,
      address: input.address ?? null,
      skypeId: input.skypeId ?? null,
      description: input.description ?? null,
      status: { value: 'active', reason: null, changedAt: null, changedBy: null },
      archive: null,
      activeStudents: 0,
      createdAt: NOW(),
      statusHistory: [],
    };
    db.teachers.push(teacher);
    return HttpResponse.json({ data: teacher }, { status: 201 });
  }),

  http.patch(`${API}/teachers/:id`, async ({ request, params }) => {
    const g = guard(request, 'staff.manage');
    if ('error' in g) return g.error;
    const t = db.teachers.find((x) => x.id === Number(params.id));
    if (!t) return notFound();
    if (t.archive) return apiError(409, 'archived', 'The record is archived.');
    const parsed = updateTeacherSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { courseIds, hourlyRateCurrency: _c, ...rest } = parsed.data;
    if (rest.email && emailTaken(rest.email, t.userId)) return takenError();
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (t as unknown as Record<string, unknown>)[key] = value;
    }
    if (courseIds !== undefined) {
      t.courses = COURSES.filter((c) => courseIds?.includes(c.id)).map(
        ({ id, nameAr, nameEn }) => ({ id, nameAr, nameEn }),
      );
    }
    t.name = [t.firstName, t.lastName].filter(Boolean).join(' ');
    syncDerived(db);
    return HttpResponse.json({ data: t });
  }),

  ...lifecycle('teachers', {
    manage: 'staff.manage',
    rows: () => db.teachers,
    schema: activeStatusChangeSchema,
    outOfService: 'inactive',
    show: (t) => t,
    refuseStatus: (t, next) =>
      next === 'inactive' && t.activeStudents > 0
        ? apiError(
            409,
            'teacher_has_students',
            'The teacher still has active students.',
            undefined,
            { activeStudents: t.activeStudents },
          )
        : null,
  }),

  // ------------------------------------------------------------------ staff
  http.get(`${API}/staff`, ({ request }) => {
    const g = guard(request, 'users.view');
    if ('error' in g) return g.error;
    const parsed = staffListQuerySchema.safeParse(queryOf(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const q = parsed.data;
    const term = q.q?.toLowerCase() ?? '';
    const rows = db.staff.filter((s) => {
      if (!!s.archive !== q.archived) return false;
      if (q.role && s.role.name !== q.role) return false;
      if (!term) return true;
      return (
        includes(s.name, term) ||
        includes(s.email, term) ||
        phoneMatch(s.phone, term) ||
        String(s.id) === term
      );
    });
    const order = q.order ?? (q.sort === 'name' ? 'asc' : 'desc');
    const key = (s: StaffRow) =>
      q.sort === 'name' ? s.name : q.sort === 'createdAt' ? s.createdAt : s.id;
    const page = paginate(rows, q, ACTIVE_STATUSES, (a, b) => compare(order, key(a), key(b)));
    return HttpResponse.json({ data: page.data.map(staffDto), meta: page.meta });
  }),

  http.get(`${API}/staff/:id`, ({ request, params }) => {
    const g = guard(request, 'users.view');
    if ('error' in g) return g.error;
    const s = db.staff.find((x) => x.id === Number(params.id));
    return s ? HttpResponse.json({ data: staffDto(s) }) : notFound();
  }),

  http.post(`${API}/staff`, async ({ request }) => {
    const g = guard(request, 'users.manage');
    if ('error' in g) return g.error;
    const parsed = createStaffSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const input = parsed.data;
    const role = findRole(input.role);
    if (!role) {
      return apiError(422, 'validation_failed', 'The given data was invalid.', {
        role: ['The selected role is invalid.'],
      });
    }
    if (role.kind === 'owner' && g.me.role?.kind !== 'owner') {
      return apiError(403, 'owner_role_locked', 'Only an owner may give the owner role.');
    }
    if (emailTaken(input.email)) return takenError();
    const id = db.nextId.staff++;
    const row: StaffRow = {
      id,
      name: input.name,
      email: input.email,
      phone: input.phone,
      role: {
        id: role.id,
        name: role.name,
        labelAr: role.labelAr,
        labelEn: role.labelEn,
        kind: role.kind as 'owner' | 'staff',
      },
      timezone: input.timezone ?? 'Africa/Cairo',
      locale: 'ar',
      status: { value: 'active', reason: null, changedAt: null, changedBy: null },
      archive: null,
      createdAt: NOW(),
      statusHistory: [],
    };
    db.staff.push(row);
    return HttpResponse.json({ data: staffDto(row) }, { status: 201 });
  }),

  http.patch(`${API}/staff/:id`, async ({ request, params }) => {
    const g = guard(request, 'users.manage');
    if ('error' in g) return g.error;
    const s = db.staff.find((x) => x.id === Number(params.id));
    if (!s) return notFound();
    if (s.archive) return apiError(409, 'archived', 'The record is archived.');
    const parsed = updateStaffSchema.safeParse(await body(request));
    if (!parsed.success) return validationFailed(parsed.error.issues);
    const { role: roleName, ...rest } = parsed.data;
    if (rest.email && emailTaken(rest.email, s.id)) return takenError();
    if (roleName !== undefined && roleName !== s.role.name) {
      if (s.id === g.me.id) {
        return apiError(422, 'cannot_change_own_role', 'You cannot change your own role.', {
          role: ['You cannot change your own role.'],
        });
      }
      const role = findRole(roleName);
      if (!role) {
        return apiError(422, 'validation_failed', 'The given data was invalid.', {
          role: ['The selected role is invalid.'],
        });
      }
      s.role = {
        id: role.id,
        name: role.name,
        labelAr: role.labelAr,
        labelEn: role.labelEn,
        kind: role.kind as 'owner' | 'staff',
      };
    }
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined && value !== null)
        (s as unknown as Record<string, unknown>)[key] = value;
    }
    return HttpResponse.json({ data: staffDto(s) });
  }),

  ...lifecycle('staff', {
    manage: 'users.manage',
    rows: () => db.staff,
    schema: activeStatusChangeSchema,
    outOfService: 'inactive',
    show: (s) => staffDto(s),
    refuseStatus: (s, next, me) => {
      if (next !== 'inactive') return null;
      if (s.id === me.id)
        return apiError(409, 'cannot_archive_self', 'You cannot deactivate yourself.');
      const owners = db.staff.filter(
        (x) => x.role.kind === 'owner' && x.status.value === 'active' && !x.archive,
      );
      return s.role.kind === 'owner' && owners.length <= 1
        ? apiError(409, 'last_admin', 'The last active owner stays.')
        : null;
    },
    refuseArchive: (s, me) =>
      s.id === me.id ? apiError(409, 'cannot_archive_self', 'You cannot archive yourself.') : null,
  }),
];
