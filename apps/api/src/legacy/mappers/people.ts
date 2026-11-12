import { allPermissions, ROLES, SYSTEM_ROLES } from '@qarabic/shared';
import { SETTING_DEFAULTS } from '../../settings/settings.service.js';
import {
  bool,
  clip,
  e164,
  familyStatus,
  gender,
  int,
  json,
  looseDate,
  oneOf,
  type Row,
  str,
  studentLanguage,
  subjectTypeOf,
  text,
  utc,
  zoneOr,
} from '../convert.js';
import { batch, type MapContext, type ModuleMapper, type TargetBatch } from '../plan.js';

const DEFAULT_ZONE = 'Africa/Cairo';
const DELETED_REASON = 'Deleted in the old system (soft delete).';

/** created_at / updated_at with the run's fallback when Laravel left them null. */
export function stamps(ctx: MapContext, r: Row): { createdAt: Date; updatedAt: Date } {
  const createdAt = utc(r.created_at, ctx.opts.appTimezone) ?? ctx.opts.fallbackNow;
  return { createdAt, updatedAt: utc(r.updated_at, ctx.opts.appTimezone) ?? createdAt };
}

export function t(ctx: MapContext, v: unknown): Date | null {
  return utc(v, ctx.opts.appTimezone);
}

/** Truncate with a `changed` issue when the value is longer than the column. */
export function fit(
  ctx: MapContext,
  table: string,
  id: unknown,
  col: string,
  v: string | null,
  max: number,
): string | null {
  if (v !== null && v.length > max) ctx.report.change(table, id, `${col} cut to ${max} characters`);
  return clip(v, max);
}

/** The lookup tables `country` (id → ISO code) and `time_zones` (id → IANA zone). */
function references(ctx: MapContext): { country: Map<number, string>; zone: Map<number, string> } {
  const country = new Map<number, string>();
  for (const r of ctx.rows('country')) {
    const iso = text(r, 'isoCode')?.toUpperCase();
    if (iso && /^[A-Z]{2}$/.test(iso)) country.set(int(r, 'id')!, iso);
  }
  const zone = new Map<number, string>();
  for (const r of ctx.rows('time_zones')) {
    const z = text(r, 'zoneName');
    if (z) zone.set(int(r, 'id')!, z);
  }
  return { country, zone };
}

export const peopleMapper: ModuleMapper = {
  name: 'people',
  sources: [
    'permissions',
    'roles',
    'role_has_permissions',
    'model_has_permissions',
    'model_has_roles',
    'users',
    'courses',
    'teachers',
    'teacher_courses',
    'families',
    'students',
    'audit_logs',
    'country',
    'time_zones',
    'app_settings',
    'settings',
  ],
  dependsOn: [],
  tables: [
    'permissions',
    'roles',
    'role_permissions',
    'users',
    'courses',
    'teachers',
    'teacher_courses',
    'families',
    'students',
    'audit_logs',
    'app_settings',
  ],
  clears: ['sessions', 'password_reset_tokens', 'status_changes'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];
    const known = new Set<string>(allPermissions());
    const { country, zone } = references(ctx);

    // ---- permissions: only the `module.action` names the new matrix knows (ids kept).
    const permissions: Row[] = [];
    const permName = new Map<number, string>();
    for (const r of ctx.rows('permissions')) {
      const id = int(r, 'id')!;
      const name = str(r, 'name') ?? '';
      permName.set(id, name);
      if (known.has(name)) permissions.push({ id, name, createdAt: stamps(ctx, r).createdAt });
      else
        ctx.report.skip(
          'permissions',
          id,
          `"${name}" is not a permission of the new role matrix (old Spatie name)`,
        );
    }
    ctx.remember(
      'permissions',
      permissions.map((p) => p.id as number),
    );
    out.push(
      batch(
        'permissions',
        'permission',
        'permissions',
        ctx.rows('permissions').length,
        permissions,
      ),
    );

    // ---- roles (ids kept; system roles keep their names, custom roles too).
    const roles: Row[] = [];
    const labelsAr = new Set<string>();
    const labelsEn = new Set<string>();
    for (const r of ctx.rows('roles')) {
      const id = int(r, 'id')!;
      const name = fit(ctx, 'roles', id, 'name', str(r, 'name'), 100) ?? `role_${id}`;
      const sys = (ROLES as readonly string[]).includes(name)
        ? SYSTEM_ROLES[name as (typeof ROLES)[number]]
        : null;
      let labelAr = text(r, 'label_ar') ?? sys?.ar ?? name;
      if (labelsAr.has(labelAr)) {
        ctx.report.change('roles', id, `label_ar "${labelAr}" repeats: suffixed with the id`);
        labelAr = `${labelAr} (${id})`;
      }
      labelsAr.add(labelAr);
      let labelEn = text(r, 'label_en') ?? sys?.en ?? null;
      if (labelEn && labelsEn.has(labelEn)) labelEn = `${labelEn} (${id})`;
      if (labelEn) labelsEn.add(labelEn);
      const kind =
        oneOf(str(r, 'kind'), ['owner', 'staff', 'teacher', 'parent'] as const) ??
        sys?.kind ??
        'staff';
      roles.push({
        id,
        name,
        labelAr,
        labelEn,
        description: fit(ctx, 'roles', id, 'description', text(r, 'description'), 500),
        kind,
        isSystem: bool(r, 'is_system') ?? !!sys,
        customizedAt: t(ctx, r.customized_at),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'roles',
      roles.map((r) => r.id as number),
    );
    out.push(batch('roles', 'role', 'roles', ctx.rows('roles').length, roles));

    const links: Row[] = [];
    let droppedLinks = 0;
    for (const r of ctx.rows('role_has_permissions')) {
      const roleId = int(r, 'role_id')!;
      const permissionId = int(r, 'permission_id')!;
      if (ctx.has('roles', roleId) && ctx.has('permissions', permissionId))
        links.push({ roleId, permissionId });
      else droppedLinks++;
    }
    if (droppedLinks) {
      ctx.report.warn(
        'role_has_permissions',
        `${droppedLinks} link(s) to old Spatie permission names not carried (the matrix sync re-applies presets)`,
      );
    }
    out.push(
      batch(
        'role_permissions',
        'rolePermission',
        'role_has_permissions',
        ctx.rows('role_has_permissions').length,
        links,
        false,
      ),
    );
    for (const r of ctx.rows('model_has_permissions')) {
      ctx.report.skip(
        'model_has_permissions',
        `${str(r, 'model_type')}#${str(r, 'model_id')}`,
        `direct permission "${permName.get(int(r, 'permission_id')!) ?? '?'}" on one user: the new system grants permissions through roles only`,
      );
    }
    if (ctx.rows('model_has_roles').length) {
      ctx.report.warn(
        'model_has_roles',
        `${ctx.rows('model_has_roles').length} Spatie role link(s) ignored: users.role_id is the source of truth`,
      );
    }

    // ---- users. Student "fake logins" (students.user_id) have no place: kept (ids stay valid) but inactive.
    const studentLogins = new Set(
      ctx
        .rows('students')
        .map((s) => int(s, 'user_id'))
        .filter((x): x is number => x !== null),
    );
    const users: Row[] = [];
    const emails = new Set<string>();
    const userZone = new Map<number, string>();
    const userName = new Map<number, string>();
    for (const r of ctx.rows('users')) {
      const id = int(r, 'id')!;
      const rawEmail = text(r, 'email');
      if (!rawEmail) {
        ctx.report.skip('users', id, 'no email');
        continue;
      }
      const email = rawEmail.toLowerCase();
      if (email !== rawEmail)
        ctx.report.change('users', id, 'email lower-cased (logins compare lower-case)');
      if (emails.has(email)) {
        ctx.report.skip(
          'users',
          id,
          `email ${email} already used by another user (case-insensitive duplicate)`,
        );
        continue;
      }
      emails.add(email);
      const rawPhone = text(r, 'phone');
      const phone = e164(rawPhone);
      if (rawPhone && !phone)
        ctx.report.change(
          'users',
          id,
          'phone is not E.164 (no country code or too long): left empty',
        );
      const tz = text(r, 'timezone');
      const timezone = zoneOr(tz, DEFAULT_ZONE);
      if (tz && tz !== timezone)
        ctx.report.change('users', id, `timezone "${tz}" is not an IANA zone: ${DEFAULT_ZONE}`);
      const deletedAt = t(ctx, r.deleted_at);
      const archivedAt = t(ctx, r.archived_at) ?? deletedAt;
      if (deletedAt)
        ctx.report.change('users', id, 'soft-deleted login: imported archived and inactive');
      const roleId = ctx.ref('roles', int(r, 'role_id'), 'users', id, 'role_id');
      let isActive = (bool(r, 'is_active') ?? true) && (bool(r, 'active') ?? true) && !deletedAt;
      if (studentLogins.has(id) && isActive) {
        isActive = false;
        ctx.report.change(
          'users',
          id,
          'student login (students.user_id): students have no login in the new system, deactivated',
        );
      }
      const name = fit(ctx, 'users', id, 'name', text(r, 'name') ?? email.split('@')[0]!, 255)!;
      userZone.set(id, timezone);
      userName.set(id, name);
      users.push({
        id,
        name,
        email,
        // Laravel bcrypt (`$2y$…`), accepted by PasswordsService and re-hashed with argon2id on login.
        passwordHash: str(r, 'password') ?? '',
        phone,
        locale: oneOf(str(r, 'locale'), ['ar', 'en'] as const) ?? 'ar',
        timezone,
        isActive,
        roleId,
        archivedAt,
        archivedById: int(r, 'archived_by'),
        archiveReason: fit(
          ctx,
          'users',
          id,
          'archive_reason',
          text(r, 'archive_reason') ?? (deletedAt ? DELETED_REASON : null),
          500,
        ),
        ...stamps(ctx, r),
      });
    }
    const userIds = new Set(users.map((u) => u.id as number));
    for (const u of users) {
      if (u.archivedById !== null && !userIds.has(u.archivedById as number)) u.archivedById = null;
    }
    ctx.remember('users', userIds);
    ctx.lookups.set('userZone', userZone);
    ctx.lookups.set('userName', userName);
    ctx.dropped('users', ['image', 'remember_token', 'parent_id', 'email_verified_at']);
    out.push(batch('users', 'user', 'users', ctx.rows('users').length, users));

    // ---- courses: one `title` → both names (Arabic names to be filled by staff later).
    const courses: Row[] = [];
    const names = new Set<string>();
    for (const r of ctx.rows('courses')) {
      const id = int(r, 'id')!;
      let nameEn = fit(ctx, 'courses', id, 'title', text(r, 'title') ?? `Course ${id}`, 110)!;
      if (names.has(nameEn.toLowerCase())) {
        ctx.report.change(
          'courses',
          id,
          `title "${nameEn}" repeats: suffixed with the id (name_en is unique)`,
        );
        nameEn = `${nameEn} (#${id})`;
      }
      names.add(nameEn.toLowerCase());
      const deleted = t(ctx, r.deleted_at);
      if (deleted) ctx.report.change('courses', id, 'soft-deleted: imported as inactive');
      courses.push({
        id,
        nameEn,
        nameAr: nameEn,
        category: /additional/i.test(str(r, 'category') ?? '') ? 'additional' : 'regular',
        isActive: !deleted,
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'courses',
      courses.map((c) => c.id as number),
    );
    ctx.dropped('courses', ['minimum_age', 'description', 'image', 'paid', 'zoom_link']);
    out.push(batch('courses', 'course', 'courses', ctx.rows('courses').length, courses));

    // ---- teachers
    const teachers: Row[] = [];
    for (const r of ctx.rows('teachers')) {
      const id = int(r, 'id')!;
      const userId = int(r, 'user_id');
      if (!ctx.has('users', userId)) {
        ctx.report.skip('teachers', id, `user_id=${userId} has no user`);
        continue;
      }
      const tzId = int(r, 'time_zone_id');
      const tz = (tzId !== null ? zone.get(tzId) : undefined) ?? userZone.get(userId!);
      const timezone = zoneOr(tz, DEFAULT_ZONE);
      if (!tz || tz !== timezone)
        ctx.report.change('teachers', id, `no valid time zone (time_zone_id=${tzId}): ${timezone}`);
      const first = text(r, 'f_name') ?? userName.get(userId!)?.split(' ')[0] ?? 'Teacher';
      const rawAlt = text(r, 'alt_phone');
      const altPhone = e164(rawAlt);
      if (rawAlt && !altPhone)
        ctx.report.change('teachers', id, 'alt_phone is not E.164: left empty');
      const countryId = int(r, 'country_id');
      const archivedAt = t(ctx, r.archived_at);
      teachers.push({
        id,
        userId,
        firstName: fit(ctx, 'teachers', id, 'f_name', first, 60),
        lastName: fit(ctx, 'teachers', id, 'l_name', text(r, 'l_name'), 60),
        altPhone,
        gender: gender(str(r, 'gender')),
        nationality: fit(ctx, 'teachers', id, 'nationality', text(r, 'nationality'), 60),
        countryCode: countryId !== null ? (country.get(countryId) ?? null) : null,
        timezone,
        age: int(r, 'age'),
        qualification: text(r, 'qualification'),
        experience: text(r, 'experience'),
        address: fit(ctx, 'teachers', id, 'address', text(r, 'address'), 500),
        skypeId: fit(ctx, 'teachers', id, 'skype_id', text(r, 'skype_id'), 100),
        description: text(r, 'description'),
        status: (bool(r, 'active') ?? true) ? 'active' : 'inactive',
        statusReason: fit(ctx, 'teachers', id, 'status_reason', text(r, 'status_reason'), 500),
        statusChangedAt: t(ctx, r.status_changed_at),
        statusChangedById: ctx.ref(
          'users',
          int(r, 'status_changed_by'),
          'teachers',
          id,
          'status_changed_by',
        ),
        archivedAt,
        archivedById: ctx.ref('users', int(r, 'archived_by'), 'teachers', id, 'archived_by'),
        archiveReason: fit(ctx, 'teachers', id, 'archive_reason', text(r, 'archive_reason'), 500),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'teachers',
      teachers.map((x) => x.id as number),
    );
    // amount_per_hour / salary_currency move to an hourly pay profile (payroll mapper, D89).
    ctx.dropped('teachers', ['image', 'nic_number', 'marital_status', 'cv']);
    out.push(batch('teachers', 'teacher', 'teachers', ctx.rows('teachers').length, teachers));

    const tc: Row[] = [];
    const seen = new Set<string>();
    for (const r of ctx.rows('teacher_courses')) {
      const teacherId = int(r, 'teacher_id');
      const courseId = int(r, 'course_id');
      const key = `${teacherId}:${courseId}`;
      if (!ctx.has('teachers', teacherId) || !ctx.has('courses', courseId) || seen.has(key)) {
        ctx.report.skip(
          'teacher_courses',
          int(r, 'id'),
          seen.has(key) ? 'duplicate pair' : `teacher ${teacherId} or course ${courseId} missing`,
        );
        continue;
      }
      seen.add(key);
      tc.push({ teacherId, courseId });
    }
    out.push(
      batch(
        'teacher_courses',
        'teacherCourse',
        'teacher_courses',
        ctx.rows('teacher_courses').length,
        tc,
        false,
      ),
    );

    // ---- families
    const families: Row[] = [];
    const familyZone = new Map<number, string>();
    for (const r of ctx.rows('families')) {
      const id = int(r, 'id')!;
      const userId = int(r, 'user_id');
      if (!ctx.has('users', userId)) {
        ctx.report.skip('families', id, `user_id=${userId} has no user`);
        continue;
      }
      const tzId = int(r, 'time_zone_id');
      const fromRef = tzId !== null ? zone.get(tzId) : undefined;
      const tz = fromRef ?? userZone.get(userId!);
      const timezone = zoneOr(tz, DEFAULT_ZONE);
      if (!fromRef)
        ctx.report.change(
          'families',
          id,
          `no time_zone_id zone: the parent login's zone ${timezone} is used`,
        );
      familyZone.set(id, timezone);
      const status = familyStatus(str(r, 'status'));
      if (!status)
        ctx.report.change('families', id, `status "${str(r, 'status')}" unknown: regular`);
      else if ((str(r, 'status') ?? '') !== status && str(r, 'status') !== null) {
        ctx.report.change('families', id, `status "${str(r, 'status')}" normalised to ${status}`);
      }
      const rawStart = text(r, 'date');
      const startDate = looseDate(rawStart);
      if (rawStart && !startDate)
        ctx.report.change('families', id, `start date "${rawStart}" is not a date: left empty`);
      const rawTrial = text(r, 'trail_date');
      const trialDate = looseDate(rawTrial);
      if (rawTrial && !trialDate)
        ctx.report.change('families', id, `trial date "${rawTrial}" is not a date: left empty`);
      const countryId = int(r, 'country_id');
      families.push({
        id,
        userId,
        countryCode: countryId !== null ? (country.get(countryId) ?? null) : null,
        timezone,
        managerId: ctx.ref('users', int(r, 'manager_id'), 'families', id, 'manager_id'),
        startDate,
        trialDate,
        zoomId: fit(ctx, 'families', id, 'zoom_id', text(r, 'zoom_id'), 100),
        whatsappGroupId: fit(ctx, 'families', id, 'group_id', text(r, 'group_id'), 100),
        comment: [text(r, 'comment'), text(r, 'notes')].filter(Boolean).join('\n\n') || null,
        status: status ?? 'regular',
        statusReason: fit(ctx, 'families', id, 'status_reason', text(r, 'status_reason'), 500),
        statusChangedAt: t(ctx, r.status_changed_at),
        statusChangedById: ctx.ref(
          'users',
          int(r, 'status_changed_by'),
          'families',
          id,
          'status_changed_by',
        ),
        archivedAt: t(ctx, r.archived_at),
        archivedById: ctx.ref('users', int(r, 'archived_by'), 'families', id, 'archived_by'),
        archiveReason: fit(ctx, 'families', id, 'archive_reason', text(r, 'archive_reason'), 500),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'families',
      families.map((f) => f.id as number),
    );
    ctx.lookups.set('familyZone', familyZone);
    ctx.dropped('families', [
      'fee',
      'wallet',
      'email',
      'belong',
      'islamic',
      'mobile',
      'invoice_type',
      'payment_cycle',
      'payment',
      'arabic',
      'currency',
      'telephone',
      'last_paid_transaction_date',
      'referral_id',
      'regular_date',
      'csr_id',
    ]);
    out.push(batch('families', 'family', 'families', ctx.rows('families').length, families));

    // ---- students (soft-deleted children are kept archived: classes and invoices point at them)
    const students: Row[] = [];
    for (const r of ctx.rows('students')) {
      const id = int(r, 'id')!;
      const familyId = int(r, 'parent_id');
      if (!ctx.has('families', familyId)) {
        ctx.report.skip('students', id, `parent_id=${familyId} has no family`);
        continue;
      }
      const deletedAt = t(ctx, r.deleted_at);
      if (deletedAt && !t(ctx, r.archived_at))
        ctx.report.change('students', id, 'soft-deleted: imported archived');
      const rawLang = text(r, 'language');
      const language = studentLanguage(rawLang);
      if (rawLang && !language)
        ctx.report.change('students', id, `language "${rawLang}" unknown: left empty`);
      const rawTeacher = text(r, 'teacher_id');
      const teacherId = rawTeacher && /^\d+$/.test(rawTeacher) ? Number(rawTeacher) : null;
      if (rawTeacher && teacherId === null)
        ctx.report.change('students', id, `teacher_id "${rawTeacher}" is not an id: left empty`);
      let age = int(r, 'age');
      if (age !== null && (age < 1 || age > 120)) {
        ctx.report.change('students', id, `age ${age} outside 1–120: left empty`);
        age = null;
      }
      students.push({
        id,
        familyId,
        name: fit(ctx, 'students', id, 'name', text(r, 'name') ?? `Student ${id}`, 120),
        email: fit(ctx, 'students', id, 'email', text(r, 'email'), 191),
        gender: gender(str(r, 'gender')),
        age,
        language,
        regularCourseId: ctx.ref(
          'courses',
          int(r, 'regular_course_id'),
          'students',
          id,
          'regular_course_id',
        ),
        additionalCourseId: ctx.ref(
          'courses',
          int(r, 'additional_course_id'),
          'students',
          id,
          'additional_course_id',
        ),
        teacherId: ctx.ref('teachers', teacherId, 'students', id, 'teacher_id'),
        startDate: looseDate(str(r, 'date')),
        zoomId: fit(ctx, 'students', id, 'zoom_id', text(r, 'zoom_id'), 100),
        remarkParent: text(r, 'remark_parent'),
        remarkTeacher: text(r, 'remark_teacher'),
        status:
          oneOf(str(r, 'status'), ['active', 'inactive'] as const) ??
          (deletedAt ? 'inactive' : 'active'),
        statusReason: fit(ctx, 'students', id, 'status_reason', text(r, 'status_reason'), 500),
        statusChangedAt: t(ctx, r.status_changed_at),
        statusChangedById: ctx.ref(
          'users',
          int(r, 'status_changed_by'),
          'students',
          id,
          'status_changed_by',
        ),
        archivedAt: t(ctx, r.archived_at) ?? deletedAt,
        archivedById: ctx.ref('users', int(r, 'archived_by'), 'students', id, 'archived_by'),
        archiveReason: fit(
          ctx,
          'students',
          id,
          'archive_reason',
          text(r, 'archive_reason') ?? (deletedAt ? DELETED_REASON : null),
          500,
        ),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'students',
      students.map((s) => s.id as number),
    );
    // fee_package_id → student_fee_packages (billing mapper). package_id/plan = old pricing tables.
    ctx.dropped('students', ['user_id', 'package_id', 'plan']);
    out.push(batch('students', 'student', 'students', ctx.rows('students').length, students));

    // ---- audit log
    const audit: Row[] = [];
    for (const r of ctx.rows('audit_logs')) {
      const id = int(r, 'id')!;
      const auditableId = int(r, 'auditable_id');
      audit.push({
        id,
        actorId: ctx.has('users', int(r, 'user_id')) ? int(r, 'user_id') : null,
        action: fit(ctx, 'audit_logs', id, 'event', text(r, 'event') ?? 'unknown', 64),
        subjectType: subjectTypeOf(str(r, 'auditable_type')),
        subjectId: auditableId !== null && auditableId <= 2_147_483_647 ? auditableId : null,
        before: json(r, 'old_values') ?? undefined,
        after: json(r, 'new_values') ?? undefined,
        ip: fit(ctx, 'audit_logs', id, 'ip_address', text(r, 'ip_address'), 45),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    ctx.dropped('audit_logs', ['user_agent']);
    out.push(batch('audit_logs', 'auditLog', 'audit_logs', ctx.rows('audit_logs').length, audit));

    // ---- settings: keys the new app knows; the rest is reported.
    const settings: Row[] = [];
    const knownKeys = new Set(Object.keys(SETTING_DEFAULTS));
    for (const r of ctx.rows('app_settings')) {
      const key = str(r, 'key')!;
      if (!knownKeys.has(key)) {
        ctx.report.skip('app_settings', key, 'key unknown to the new app (no setting reads it)');
        continue;
      }
      const value = json(r, 'value');
      settings.push({
        key,
        value: value === null ? undefined : value,
        updatedById: ctx.has('users', int(r, 'updated_by')) ? int(r, 'updated_by') : null,
        updatedAt: t(ctx, r.updated_at) ?? ctx.opts.fallbackNow,
      });
    }
    out.push(
      batch(
        'app_settings',
        'appSetting',
        'app_settings',
        ctx.rows('app_settings').length,
        settings.filter((s) => s.value !== undefined),
        false,
      ),
    );
    if (ctx.rows('settings').length) {
      ctx.report.noCounterpart(
        'settings',
        ctx.rows('settings').length,
        'old settings row (time zone used as the academy zone fallback; social links not carried)',
      );
    }
    return out;
  },
};
