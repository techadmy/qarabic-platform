import {
  familyDetailSchema,
  familyListResponseSchema,
  peopleLookupsSchema,
  staffListResponseSchema,
  staffSchema,
  studentDetailSchema,
  studentListResponseSchema,
  teacherDetailSchema,
  teacherListResponseSchema,
  type ArchiveInput,
  type CreateFamilyInput,
  type CreateStaffInput,
  type CreateStudentInput,
  type CreateTeacherInput,
  type FamilyDetailDto,
  type FamilyDto,
  type Paginated,
  type PeopleLookups,
  type StaffDto,
  type StudentDetailDto,
  type StudentDto,
  type TeacherDetailDto,
  type TeacherDto,
  type UpdateFamilyInput,
  type UpdateStaffInput,
  type UpdateStudentInput,
  type UpdateTeacherInput,
} from '@qarabic/shared';
import { z } from 'zod';
import { apiFetch } from './client';

/**
 * People endpoints (`/families`, `/students`, `/teachers`, `/staff`, `/people/lookups`). Every
 * answer is parsed with the `@qarabic/shared` schema, so the UI never reads a shape the API does
 * not promise (and the MSW mocks are held to the same contract).
 */
export type PeopleKind = 'families' | 'students' | 'teachers' | 'staff';

export interface ListRows {
  families: FamilyDto;
  students: StudentDto;
  teachers: TeacherDto;
  staff: StaffDto;
}
export interface DetailRows {
  families: FamilyDetailDto;
  students: StudentDetailDto;
  teachers: TeacherDetailDto;
  staff: StaffDto;
}
export interface CreateInputs {
  families: CreateFamilyInput;
  students: CreateStudentInput;
  teachers: CreateTeacherInput;
  staff: CreateStaffInput;
}
export interface UpdateInputs {
  families: UpdateFamilyInput;
  students: UpdateStudentInput;
  teachers: UpdateTeacherInput;
  staff: UpdateStaffInput;
}

const listSchemas = {
  families: familyListResponseSchema,
  students: studentListResponseSchema,
  teachers: teacherListResponseSchema,
  staff: staffListResponseSchema,
};

const detailSchemas = {
  families: z.object({ data: familyDetailSchema }),
  students: z.object({ data: studentDetailSchema }),
  teachers: z.object({ data: teacherDetailSchema }),
  staff: z.object({ data: staffSchema }),
};

/** List query as URL params: empty values are left out. */
export function toSearchParams(query: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, value === true ? '1' : String(value));
  }
  return params.toString();
}

export async function fetchPeopleList<K extends PeopleKind>(
  kind: K,
  query: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<Paginated<ListRows[K]>> {
  const qs = toSearchParams(query);
  const res = await apiFetch(`/${kind}${qs ? `?${qs}` : ''}`, {
    schema: listSchemas[kind],
    signal,
  });
  return res as unknown as Paginated<ListRows[K]>;
}

export async function fetchPerson<K extends PeopleKind>(
  kind: K,
  id: number,
  signal?: AbortSignal,
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}/${id}`, { schema: detailSchemas[kind], signal });
  return res.data as DetailRows[K];
}

export async function createPerson<K extends PeopleKind>(
  kind: K,
  body: CreateInputs[K],
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}`, { method: 'POST', body, schema: detailSchemas[kind] });
  return res.data as DetailRows[K];
}

export async function updatePerson<K extends PeopleKind>(
  kind: K,
  id: number,
  body: UpdateInputs[K],
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}/${id}`, {
    method: 'PATCH',
    body,
    schema: detailSchemas[kind],
  });
  return res.data as DetailRows[K];
}

export async function changeStatus<K extends PeopleKind>(
  kind: K,
  id: number,
  body: { status: string; reason?: string | null },
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}/${id}/status`, {
    method: 'POST',
    body,
    schema: detailSchemas[kind],
  });
  return res.data as DetailRows[K];
}

export async function archivePerson<K extends PeopleKind>(
  kind: K,
  id: number,
  body: ArchiveInput,
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}/${id}`, {
    method: 'DELETE',
    body,
    schema: detailSchemas[kind],
  });
  return res.data as DetailRows[K];
}

export async function restorePerson<K extends PeopleKind>(
  kind: K,
  id: number,
): Promise<DetailRows[K]> {
  const res = await apiFetch(`/${kind}/${id}/restore`, {
    method: 'POST',
    schema: detailSchemas[kind],
  });
  return res.data as DetailRows[K];
}

const lookupsResponseSchema = z.object({ data: peopleLookupsSchema });

export async function fetchLookups(signal?: AbortSignal): Promise<PeopleLookups> {
  return (await apiFetch('/people/lookups', { schema: lookupsResponseSchema, signal })).data;
}
