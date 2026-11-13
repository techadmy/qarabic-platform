import { z } from 'zod';
import { countryCodeSchema, timeZoneSchema } from './countries.js';

/**
 * People (N1): families, students, teachers and staff — the request/response contract of
 * `/api/v1/{families,students,teachers,staff,people/lookups}`. Ported from the Laravel
 * `api_v1_people.php` routes, form requests and resources (docs/28, D122–D130, D138).
 * Field names are camelCase; dates are `YYYY-MM-DD`; instants are ISO 8601 UTC strings.
 */

// ------------------------------------------------------------------ enums + labels

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

/** Family account status (docs/06 §4, docs/28 §4.1). Old codes: 1 regular, 11 trial, 7 on leave, 17 suspended, 3 deactivated. */
export const FAMILY_STATUSES = [
  'regular',
  'trial',
  'on_leave',
  'suspended',
  'deactivated',
] as const;
export type FamilyStatus = (typeof FAMILY_STATUSES)[number];
export const familyStatusSchema = z.enum(FAMILY_STATUSES);
export const FAMILY_STATUS_LABELS: Labels<FamilyStatus> = {
  regular: { ar: 'منتظمة', en: 'Regular' },
  trial: { ar: 'تجريبية', en: 'Trial' },
  on_leave: { ar: 'في إجازة', en: 'On leave' },
  suspended: { ar: 'معلّقة', en: 'Suspended' },
  deactivated: { ar: 'غير نشطة', en: 'Deactivated' },
};

/** Students, teachers and staff: active / inactive. */
export const ACTIVE_STATUSES = ['active', 'inactive'] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export const activeStatusSchema = z.enum(ACTIVE_STATUSES);
export const ACTIVE_STATUS_LABELS: Labels<ActiveStatus> = {
  active: { ar: 'نشط', en: 'Active' },
  inactive: { ar: 'غير نشط', en: 'Inactive' },
};

/** Statuses that need a reason (D123; the old system required a comment for them). */
export const FAMILY_STATUSES_NEEDING_REASON: readonly FamilyStatus[] = [
  'on_leave',
  'suspended',
  'deactivated',
];
export const ACTIVE_STATUSES_NEEDING_REASON: readonly ActiveStatus[] = ['inactive'];

/** A new family starts as regular or trial; every later change goes through `/status`. */
export const FAMILY_CREATE_STATUSES = ['regular', 'trial'] as const;

export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];
export const genderSchema = z.enum(GENDERS);
export const GENDER_LABELS: Labels<Gender> = {
  male: { ar: 'ذكر', en: 'Male' },
  female: { ar: 'أنثى', en: 'Female' },
};

/** Student language (Laravel `Student::languages`: 1 English, 2 Urdu, 3 Eng-Urdu, 4 Pushto, 5 Arabic). */
export const STUDENT_LANGUAGES = ['english', 'urdu', 'english_urdu', 'pashto', 'arabic'] as const;
/** Languages a teacher teaches in (T2, docs/33 §4.1); a student's `english_urdu` matches either. */
export const TEACHER_LANGUAGES = ['arabic', 'english', 'urdu', 'pashto'] as const;
export type TeacherLanguage = (typeof TEACHER_LANGUAGES)[number];
export const TEACHER_LANGUAGE_LABELS: Record<TeacherLanguage, { ar: string; en: string }> = {
  arabic: { ar: 'العربية', en: 'Arabic' },
  english: { ar: 'الإنجليزية', en: 'English' },
  urdu: { ar: 'الأردية', en: 'Urdu' },
  pashto: { ar: 'البشتو', en: 'Pashto' },
};
/** Who a teacher takes for trials: children (under 16), adults, or both. */
export const TEACHER_AUDIENCES = ['children', 'adults', 'both'] as const;
export type TeacherAudience = (typeof TEACHER_AUDIENCES)[number];
export const TEACHER_AUDIENCE_LABELS: Record<TeacherAudience, { ar: string; en: string }> = {
  children: { ar: 'الأطفال', en: 'Children' },
  adults: { ar: 'الكبار', en: 'Adults' },
  both: { ar: 'الأطفال والكبار', en: 'Children and adults' },
};
/** A student of this age or older counts as an adult for `audience`. */
export const ADULT_AGE = 16;
export type StudentLanguage = (typeof STUDENT_LANGUAGES)[number];
export const studentLanguageSchema = z.enum(STUDENT_LANGUAGES);
export const STUDENT_LANGUAGE_LABELS: Labels<StudentLanguage> = {
  english: { ar: 'الإنجليزية', en: 'English' },
  urdu: { ar: 'الأردية', en: 'Urdu' },
  english_urdu: { ar: 'الإنجليزية والأردية', en: 'English and Urdu' },
  pashto: { ar: 'البشتو', en: 'Pashto' },
  arabic: { ar: 'العربية', en: 'Arabic' },
};

export const COURSE_CATEGORIES = ['regular', 'additional'] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];
export const COURSE_CATEGORY_LABELS: Labels<CourseCategory> = {
  regular: { ar: 'أساسي', en: 'Regular' },
  additional: { ar: 'إضافي', en: 'Additional' },
};

// ------------------------------------------------------------------ field rules

/** E.164: `+` then 7–15 digits, first digit not 0 (UX §5.6). */
export const PHONE_E164 = /^\+[1-9]\d{6,14}$/;

/** Strips spaces, dashes, dots and brackets, so "+44 7700-900 123" validates as `+447700900123`. */
export const phoneSchema = z
  .string()
  .transform((v) => v.replace(/[\s\-().]/g, ''))
  .pipe(
    z.string().regex(PHONE_E164, { message: 'Use the international format, e.g. +447700900123.' }),
  );

export const emailSchema = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.email().max(191));

/** `YYYY-MM-DD` */
export const dateOnlySchema = z.iso.date();

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Required text: trimmed, not blank. */
const requiredText = (max: number) => z.string().trim().min(1).max(max);

/** Optional field that may be cleared: `""` and `null` both clear it (Laravel ConvertEmptyStringsToNull). */
function clearable<T extends z.ZodType>(schema: T) {
  return z.preprocess(blankToNull, schema.nullable()).optional();
}

const optionalText = (max: number) => clearable(z.string().trim().max(max));
const id = z.number().int().positive();

/** Money in, as a number or a decimal string with at most 2 decimals; out as a `"120.00"` string. */
export const moneyInputSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v) => String(v))
  .pipe(
    z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, {
      message: 'Use a positive amount with at most 2 decimals.',
    }),
  )
  .transform((v) => Number(v).toFixed(2))
  .refine((v) => Number(v) <= 100_000, { message: 'The amount may not be greater than 100000.' });

const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, { message: 'Use a 3-letter currency code.' });

// ------------------------------------------------------------------ shared response blocks

export const personRefSchema = z.object({ id: z.number().int(), name: z.string() });
export type PersonRef = z.infer<typeof personRefSchema>;

export const courseRefSchema = z.object({
  id: z.number().int(),
  nameAr: z.string(),
  nameEn: z.string(),
});
export type CourseRef = z.infer<typeof courseRefSchema>;

/** The `status` block every People record shares (docs/28 §4). */
export function statusInfoSchema<T extends z.ZodType>(value: T) {
  return z.object({
    value,
    reason: z.string().nullable(),
    changedAt: z.string().nullable(),
    changedBy: personRefSchema.nullable(),
  });
}

/** The `archive` block (D128): null while the record is in use. */
export const archiveInfoSchema = z
  .object({
    archivedAt: z.string(),
    reason: z.string().nullable(),
    by: personRefSchema.nullable(),
  })
  .nullable();
export type ArchiveInfo = z.infer<typeof archiveInfoSchema>;

/** One row of a record's status history (newest first). */
export const statusHistoryEntrySchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string().nullable(),
  at: z.string(),
  by: personRefSchema.nullable(),
});
export type StatusHistoryEntry = z.infer<typeof statusHistoryEntrySchema>;

// ------------------------------------------------------------------ lists

/** `?archived=1|true|0|false` */
const queryBool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

const queryId = z.coerce.number().int().positive().max(2_147_483_647);

/** Query params every People list accepts (docs/15 §5.4.1): instant search, deleted switch, paging, order. */
export const listQueryBaseSchema = z.object({
  /** Instant search; `%` and `_` are literal text. */
  q: z.string().trim().max(100).optional(),
  /** Archived ("deleted", D128) records instead of the live ones. */
  archived: queryBool.default(false),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  order: z.enum(['asc', 'desc']).optional(),
});

/** Page-based pagination (the current app's `useListQuery`: `page`, `per`). */
export const pageMetaSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  lastPage: z.number().int(),
  /**
   * Counts for the status tabs (`all` + one per status), over the same search and filters but
   * ignoring the `status` filter, so every tab shows how many rows it would list.
   */
  counts: z.record(z.string(), z.number().int()),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}
export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

// ------------------------------------------------------------------ families

export const familyListQuerySchema = listQueryBaseSchema.extend({
  status: familyStatusSchema.optional(),
  managerId: queryId.optional(),
  countryCode: countryCodeSchema.optional(),
  sort: z.enum(['id', 'parentName', 'startDate', 'createdAt']).default('id'),
});
export type FamilyListQuery = z.input<typeof familyListQuerySchema>;

export const familyChildSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: activeStatusSchema,
});

export const familySchema = z.object({
  id: z.number().int(),
  parentUserId: z.number().int(),
  parentName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  countryCode: z.string().nullable(),
  timezone: z.string(),
  manager: personRefSchema.nullable(),
  startDate: z.string().nullable(),
  trialDate: z.string().nullable(),
  zoomId: z.string().nullable(),
  whatsappGroupId: z.string().nullable(),
  /** Staff note; null for a parent viewing their own family. */
  comment: z.string().nullable(),
  status: statusInfoSchema(familyStatusSchema),
  archive: archiveInfoSchema,
  /** Live (not archived) children, archived ones too when the family itself is archived. */
  students: z.array(familyChildSchema),
  createdAt: z.string(),
});
export type FamilyDto = z.infer<typeof familySchema>;

/** `GET /families/:id`: the record plus its status history (staff only; empty for a parent). */
export const familyDetailSchema = familySchema.extend({
  statusHistory: z.array(statusHistoryEntrySchema),
});
export type FamilyDetailDto = z.infer<typeof familyDetailSchema>;

export const familyListResponseSchema = paginatedSchema(familySchema);

const familyFields = {
  countryCode: clearable(countryCodeSchema),
  managerId: clearable(id),
  startDate: clearable(dateOnlySchema),
  trialDate: clearable(dateOnlySchema),
  zoomId: optionalText(100),
  whatsappGroupId: optionalText(100),
  comment: optionalText(2000),
};

/** `POST /families`: creates the parent login (random password, D126) and the family. */
export const createFamilySchema = z.object({
  parentName: requiredText(120),
  email: emailSchema,
  phone: phoneSchema,
  timezone: timeZoneSchema,
  ...familyFields,
  status: z.enum(FAMILY_CREATE_STATUSES).default('regular'),
});
export type CreateFamilyInput = z.input<typeof createFamilySchema>;

/** `PATCH /families/:id`: only the fields sent change; status goes through `/status`. */
export const updateFamilySchema = z.object({
  parentName: requiredText(120).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  timezone: timeZoneSchema.optional(),
  ...familyFields,
  status: z.never({ error: 'Change the status with POST /families/{id}/status.' }).optional(),
});
export type UpdateFamilyInput = z.input<typeof updateFamilySchema>;

// ------------------------------------------------------------------ students

export const studentListQuerySchema = listQueryBaseSchema.extend({
  status: activeStatusSchema.optional(),
  familyId: queryId.optional(),
  teacherId: queryId.optional(),
  courseId: queryId.optional(),
  sort: z.enum(['id', 'name', 'createdAt']).default('id'),
});
export type StudentListQuery = z.input<typeof studentListQuerySchema>;

/**
 * A student. For a teacher viewer (D138) `email` is left out and `family` carries only the
 * family id, country and time zone: never the parent's name or contact details.
 */
export const studentSchema = z.object({
  id: z.number().int(),
  familyId: z.number().int(),
  family: z.object({
    id: z.number().int(),
    /** Absent for a teacher viewer. */
    parentName: z.string().optional(),
    countryCode: z.string().nullable(),
    timezone: z.string(),
  }),
  name: z.string(),
  /** Absent for a teacher viewer. */
  email: z.string().nullable().optional(),
  gender: genderSchema.nullable(),
  age: z.number().int().nullable(),
  language: studentLanguageSchema.nullable(),
  regularCourse: courseRefSchema.nullable(),
  additionalCourse: courseRefSchema.nullable(),
  teacher: personRefSchema.nullable(),
  startDate: z.string().nullable(),
  zoomId: z.string().nullable(),
  remarkParent: z.string().nullable(),
  remarkTeacher: z.string().nullable(),
  status: statusInfoSchema(activeStatusSchema),
  archive: archiveInfoSchema,
  createdAt: z.string(),
});
export type StudentDto = z.infer<typeof studentSchema>;

export const studentDetailSchema = studentSchema.extend({
  statusHistory: z.array(statusHistoryEntrySchema),
});
export type StudentDetailDto = z.infer<typeof studentDetailSchema>;

export const studentListResponseSchema = paginatedSchema(studentSchema);

const studentFields = {
  email: clearable(emailSchema),
  gender: clearable(genderSchema),
  age: clearable(z.number().int().min(3).max(99)),
  language: clearable(studentLanguageSchema),
  regularCourseId: clearable(id),
  additionalCourseId: clearable(id),
  teacherId: clearable(id),
  startDate: clearable(dateOnlySchema),
  zoomId: optionalText(100),
  remarkParent: optionalText(2000),
  remarkTeacher: optionalText(2000),
};

/** `POST /students`: no login account (the legacy store made a fake one). */
export const createStudentSchema = z.object({
  familyId: id,
  name: requiredText(120),
  ...studentFields,
});
export type CreateStudentInput = z.input<typeof createStudentSchema>;

export const updateStudentSchema = z.object({
  familyId: id.optional(),
  name: requiredText(120).optional(),
  ...studentFields,
});
export type UpdateStudentInput = z.input<typeof updateStudentSchema>;

// ------------------------------------------------------------------ teachers

export const teacherListQuerySchema = listQueryBaseSchema.extend({
  status: activeStatusSchema.optional(),
  courseId: queryId.optional(),
  sort: z.enum(['id', 'name', 'createdAt']).default('id'),
});
export type TeacherListQuery = z.input<typeof teacherListQuerySchema>;

export const teacherSchema = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  altPhone: z.string().nullable(),
  gender: genderSchema.nullable(),
  nationality: z.string().nullable(),
  countryCode: z.string().nullable(),
  timezone: z.string(),
  age: z.number().int().nullable(),
  /** Decimal string, e.g. `"120.00"`; null when not set. */
  hourlyRate: z.string().nullable(),
  hourlyRateCurrency: z.string(),
  courses: z.array(courseRefSchema),
  /** T2 trial settings (defaults keep older clients and mocks valid). */
  acceptsTrials: z.boolean().default(true),
  maxTrialsPerWeek: z.number().int().nullable().default(null),
  audience: z.enum(TEACHER_AUDIENCES).default('both'),
  languages: z.array(z.enum(TEACHER_LANGUAGES)).default([]),
  qualification: z.string().nullable(),
  experience: z.string().nullable(),
  address: z.string().nullable(),
  skypeId: z.string().nullable(),
  description: z.string().nullable(),
  status: statusInfoSchema(activeStatusSchema),
  archive: archiveInfoSchema,
  /** Active, not archived students assigned to the teacher (deactivation is refused while > 0). */
  activeStudents: z.number().int(),
  createdAt: z.string(),
});
export type TeacherDto = z.infer<typeof teacherSchema>;

export const teacherDetailSchema = teacherSchema.extend({
  statusHistory: z.array(statusHistoryEntrySchema),
});
export type TeacherDetailDto = z.infer<typeof teacherDetailSchema>;

export const teacherListResponseSchema = paginatedSchema(teacherSchema);

const teacherFields = {
  lastName: optionalText(60),
  altPhone: clearable(phoneSchema),
  gender: clearable(genderSchema),
  nationality: optionalText(60),
  countryCode: clearable(countryCodeSchema),
  age: clearable(z.number().int().min(18).max(90)),
  hourlyRate: clearable(moneyInputSchema),
  /** Teachers are paid in the academy's pay currency (EGP); another currency is set by payroll (N7). */
  hourlyRateCurrency: currencyCode.optional(),
  courseIds: clearable(
    z
      .array(id)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Courses must be distinct.' }),
  ),
  qualification: optionalText(2000),
  experience: optionalText(2000),
  address: optionalText(500),
  skypeId: optionalText(100),
  description: optionalText(2000),
  /** «يقبل الحصص التجريبية» (T2). */
  acceptsTrials: z.boolean().optional(),
  /** Max trial classes per week (teacher's week); null = no cap. */
  maxTrialsPerWeek: clearable(z.number().int().min(1).max(50)),
  audience: z.enum(TEACHER_AUDIENCES).optional(),
  languages: z
    .array(z.enum(TEACHER_LANGUAGES))
    .max(TEACHER_LANGUAGES.length)
    .transform((a) => [...new Set(a)])
    .optional(),
};

/** `POST /teachers`: creates the teacher login (random password, D126). A `password` field is ignored. */
export const createTeacherSchema = z.object({
  firstName: requiredText(60),
  email: emailSchema,
  phone: phoneSchema,
  timezone: timeZoneSchema,
  ...teacherFields,
});
export type CreateTeacherInput = z.input<typeof createTeacherSchema>;

export const updateTeacherSchema = z.object({
  firstName: requiredText(60).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  timezone: timeZoneSchema.optional(),
  ...teacherFields,
});
export type UpdateTeacherInput = z.input<typeof updateTeacherSchema>;

// ------------------------------------------------------------------ staff

export const staffListQuerySchema = listQueryBaseSchema.extend({
  status: activeStatusSchema.optional(),
  /** Role name (`monitor`, `custom_12`, …). */
  role: z.string().trim().max(100).optional(),
  sort: z.enum(['name', 'id', 'createdAt']).default('name'),
});
export type StaffListQuery = z.input<typeof staffListQuerySchema>;

export const staffRoleRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  labelAr: z.string(),
  labelEn: z.string().nullable(),
  kind: z.enum(['owner', 'staff']),
});

/** A staff member: any user whose role is of kind owner or staff, custom roles included (docs/29). */
export const staffSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  role: staffRoleRefSchema,
  timezone: z.string(),
  locale: z.enum(['ar', 'en']),
  status: statusInfoSchema(activeStatusSchema),
  archive: archiveInfoSchema,
  createdAt: z.string(),
});
export type StaffDto = z.infer<typeof staffSchema>;

export const staffListResponseSchema = paginatedSchema(staffSchema);

/** `POST /staff`: random password (D126); only an owner may give the owner role (docs/29). */
export const createStaffSchema = z.object({
  name: requiredText(120),
  email: emailSchema,
  phone: phoneSchema,
  role: z.string().trim().min(1).max(100),
  timezone: clearable(timeZoneSchema),
});
export type CreateStaffInput = z.input<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  name: requiredText(120).optional(),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  role: z.string().trim().min(1).max(100).optional(),
  timezone: clearable(timeZoneSchema),
});
export type UpdateStaffInput = z.input<typeof updateStaffSchema>;

// ------------------------------------------------------------------ status + archive

const reasonSchema = z.preprocess(blankToNull, z.string().trim().min(3).max(500).nullable());

function statusChange<S extends readonly [string, ...string[]]>(
  statuses: S,
  needsReason: readonly string[],
) {
  return z
    .object({ status: z.enum(statuses), reason: reasonSchema.optional() })
    .superRefine((v, ctx) => {
      if (needsReason.includes(v.status) && !v.reason) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'A reason is required for this status.',
        });
      }
    })
    .transform((v) => ({ status: v.status, reason: v.reason ?? null }));
}

/** `POST /families/:id/status` */
export const familyStatusChangeSchema = statusChange(
  FAMILY_STATUSES,
  FAMILY_STATUSES_NEEDING_REASON,
);
export type FamilyStatusChangeInput = z.input<typeof familyStatusChangeSchema>;

/** `POST /{students|teachers|staff}/:id/status` */
export const activeStatusChangeSchema = statusChange(
  ACTIVE_STATUSES,
  ACTIVE_STATUSES_NEEDING_REASON,
);
export type ActiveStatusChangeInput = z.input<typeof activeStatusChangeSchema>;

/** `DELETE /{families|students|teachers|staff}/:id`: archive with a reason (D128). */
export const archiveSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type ArchiveInput = z.input<typeof archiveSchema>;

// ------------------------------------------------------------------ lookups

export const courseSchema = z.object({
  id: z.number().int(),
  nameAr: z.string(),
  nameEn: z.string(),
  category: z.enum(COURSE_CATEGORIES),
  isActive: z.boolean(),
});
export type CourseDto = z.infer<typeof courseSchema>;

/** `GET /people/lookups`: the pickers of the People forms. */
export const peopleLookupsSchema = z.object({
  countries: z.array(z.object({ code: z.string(), nameAr: z.string(), nameEn: z.string() })),
  courses: z.array(courseSchema),
  /** Active staff whose role can manage families (docs/29: by permission, not by role name). */
  managers: z.array(personRefSchema),
  /** Active, not archived teachers. */
  teachers: z.array(personRefSchema),
  /** Roles the viewer may give on the staff form (owner role for owners only). */
  staffRoles: z.array(staffRoleRefSchema),
  payCurrencies: z.array(z.string()),
  defaultPayCurrency: z.string(),
});
export type PeopleLookups = z.infer<typeof peopleLookupsSchema>;
