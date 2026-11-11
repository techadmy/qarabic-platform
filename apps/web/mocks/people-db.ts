import {
  ACTIVE_STATUSES,
  countryList,
  FAMILY_STATUSES,
  type CourseDto,
  type FamilyDetailDto,
  type StaffDto,
  type StatusHistoryEntry,
  type StudentDetailDto,
  type TeacherDetailDto,
} from '@qarabic/shared';

/**
 * In-memory People data for the MSW mocks (fake people only: invented names, `example.com` and
 * `qarabic.test` addresses, `+1 555` and `+44 7700 900` numbers). Same shapes as the API's DTOs.
 * `resetPeopleDb()` puts it back for every test.
 */

const NOW = '2026-11-10T09:00:00.000Z';

export const COURSES: CourseDto[] = [
  {
    id: 1,
    nameEn: 'Noorani Qaida',
    nameAr: 'القاعدة النورانية',
    category: 'regular',
    isActive: true,
  },
  {
    id: 2,
    nameEn: 'Quran Reading (Nazra)',
    nameAr: 'تلاوة القرآن نظرًا',
    category: 'regular',
    isActive: true,
  },
  { id: 3, nameEn: 'Quran Hifz', nameAr: 'حفظ القرآن الكريم', category: 'regular', isActive: true },
  { id: 4, nameEn: 'Tajweed', nameAr: 'التجويد', category: 'additional', isActive: true },
  {
    id: 5,
    nameEn: 'Arabic Language',
    nameAr: 'اللغة العربية',
    category: 'additional',
    isActive: true,
  },
  {
    id: 6,
    nameEn: 'Islamic Studies',
    nameAr: 'الدراسات الإسلامية',
    category: 'additional',
    isActive: true,
  },
];

const courseRef = (id: number | null) => {
  const c = COURSES.find((x) => x.id === id);
  return c ? { id: c.id, nameAr: c.nameAr, nameEn: c.nameEn } : null;
};

const ADMIN_REF = { id: 1, name: 'مدير النظام' };

/** Staff rows (users of kind owner/staff). Ids are user ids; 1 and 4 are mock logins. */
export interface StaffRow extends StaffDto {
  statusHistory: StatusHistoryEntry[];
}

/** The custom role of the mock supervisor (id 10, `custom_10`). */
export const SUPERVISOR_ROLE = {
  id: 10,
  name: 'custom_10',
  labelAr: 'مشرف',
  labelEn: 'Supervisor',
  kind: 'staff' as const,
};

function staffRole(
  name: string,
  labelAr: string,
  labelEn: string,
  id: number,
  kind: 'owner' | 'staff' = 'staff',
) {
  return { id, name, labelAr, labelEn, kind };
}

const PLACES: { country: string; tz: string; phone: (n: number) => string }[] = [
  {
    country: 'US',
    tz: 'America/New_York',
    phone: (n) => `+1555010${String(n).padStart(4, '0')}`.slice(0, 12),
  },
  { country: 'GB', tz: 'Europe/London', phone: (n) => `+447700900${String(100 + n).slice(-3)}` },
  {
    country: 'CA',
    tz: 'America/Toronto',
    phone: (n) => `+1555020${String(n).padStart(4, '0')}`.slice(0, 12),
  },
  { country: 'AU', tz: 'Australia/Sydney', phone: (n) => `+6155501${String(1000 + n).slice(-4)}` },
  { country: 'AE', tz: 'Asia/Dubai', phone: (n) => `+97155501${String(1000 + n).slice(-4)}` },
  { country: 'DE', tz: 'Europe/Berlin', phone: (n) => `+4915550${String(10000 + n).slice(-5)}` },
  { country: 'PK', tz: 'Asia/Karachi', phone: (n) => `+9230055${String(10000 + n).slice(-5)}` },
];

const PARENT_NAMES = [
  'Omar Rahman',
  'Yusuf Hassan',
  'Aisha Aziz',
  'Fatima Chaudhry',
  'Ibrahim Malik',
  'Maryam Mansour',
  'Khalid Darwish',
  'Zainab Ali',
  'Hamza Saleh',
  'Sara Khan',
  'Bilal Qureshi',
  'Huda Farouk',
  'Tariq Siddiqui',
  'Noor Haddad',
  'Adam Yilmaz',
  'Layla Karim',
  'Samir Nasser',
  'Amina Bello',
  'Rashid Omar',
  'Hana Suleiman',
  'Idris Bakr',
  'Salma Rauf',
  'Zaid Hamdan',
  'Rania Jaber',
  'Faisal Anwar',
  'Yasmin Taha',
  'Karim Lutfi',
  'Dina Shams',
];
const CHILD_NAMES = [
  'Ali',
  'Mariam',
  'Hassan',
  'Safiya',
  'Musa',
  'Ruqayya',
  'Isa',
  'Khadija',
  'Yahya',
  'Asma',
  'Dawud',
  'Sumayya',
  'Nuh',
  'Hafsa',
  'Ayyub',
  'Zahra',
];

const TEACHER_ROWS: [string, string, 'male' | 'female'][] = [
  ['معلم', 'تجريبي', 'male'],
  ['Ahmed', 'Fathy', 'male'],
  ['Mahmoud', 'Saeed', 'male'],
  ['Nour', 'Adel', 'female'],
  ['Huda', 'Mostafa', 'female'],
  ['Mostafa', 'Kamal', 'male'],
  ['Salma', 'Ibrahim', 'female'],
  ['Youssef', 'Ramadan', 'male'],
];

interface Db {
  families: FamilyDetailDto[];
  students: StudentDetailDto[];
  teachers: TeacherDetailDto[];
  staff: StaffRow[];
  nextId: { families: number; students: number; teachers: number; staff: number };
}

function status<T extends string>(value: T, reason: string | null = null) {
  return { value, reason, changedAt: reason ? NOW : null, changedBy: reason ? ADMIN_REF : null };
}

function familyStatusFor(i: number): (typeof FAMILY_STATUSES)[number] {
  if (i <= 16) return 'regular';
  if (i <= 19) return 'trial';
  if (i <= 21) return 'on_leave';
  if (i <= 23) return 'suspended';
  return 'deactivated';
}

function build(): Db {
  const teachers: TeacherDetailDto[] = TEACHER_ROWS.map(([first, last, gender], index) => {
    const id = index + 1;
    const place = PLACES[(index + 3) % PLACES.length]!;
    const inactive = id === 8;
    return {
      id,
      userId: id === 1 ? 2 : 100 + id,
      firstName: first,
      lastName: last,
      name: `${first} ${last}`,
      email:
        id === 1
          ? 'teacher@qarabic.test'
          : `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      phone: `+2010000002${String(id).padStart(2, '0')}`,
      altPhone: null,
      gender,
      nationality: 'Egyptian',
      countryCode: 'EG',
      timezone: id === 4 ? place.tz : 'Africa/Cairo',
      age: 26 + id,
      hourlyRate: `${(90 + id * 5).toFixed(2)}`,
      hourlyRateCurrency: 'EGP',
      courses: [courseRef(1 + (id % 3))!, courseRef(4 + (id % 3))!],
      qualification: 'Ijazah in Hafs an Asim',
      experience: `${id + 2} years teaching online`,
      address: null,
      skypeId: null,
      description: null,
      status: inactive ? status('inactive', 'Left the academy') : status('active'),
      archive: null,
      activeStudents: 0,
      createdAt: `2026-0${1 + (id % 8)}-1${id % 9}T08:00:00.000Z`,
      statusHistory: inactive
        ? [{ from: 'active', to: 'inactive', reason: 'Left the academy', at: NOW, by: ADMIN_REF }]
        : [],
    };
  });

  const families: FamilyDetailDto[] = [];
  const students: StudentDetailDto[] = [];
  let studentId = 1;
  for (let i = 1; i <= 28; i++) {
    const place = PLACES[(i - 1) % PLACES.length]!;
    const isDemoParent = i === 1;
    const parentName = isDemoParent ? 'ولي أمر تجريبي' : PARENT_NAMES[i - 1]!;
    const value = familyStatusFor(i);
    const archived = i >= 27;
    const reason =
      value === 'on_leave'
        ? 'Travelling for the summer'
        : value === 'suspended'
          ? 'Unpaid invoice'
          : value === 'deactivated'
            ? 'Finished the course'
            : null;
    const family: FamilyDetailDto = {
      id: i,
      parentUserId: isDemoParent ? 3 : 200 + i,
      parentName,
      email: isDemoParent
        ? 'parent@qarabic.test'
        : `${parentName.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      phone: place.phone(i),
      countryCode: place.country,
      timezone: place.tz,
      manager: i % 2 ? { id: 11, name: 'Sherif Manager' } : { id: 13, name: 'Mona CSR' },
      startDate: `2026-${String(1 + (i % 10)).padStart(2, '0')}-0${1 + (i % 9)}`,
      trialDate: i % 3 ? `2026-${String(1 + (i % 10)).padStart(2, '0')}-01` : null,
      zoomId: i % 4 ? null : `8${i}2 345 678${i % 10}`,
      whatsappGroupId: null,
      comment: i % 5 === 0 ? 'Prefers evening classes (family local time).' : null,
      status: status(value, reason),
      archive: archived ? { archivedAt: NOW, reason: 'Duplicate account', by: ADMIN_REF } : null,
      students: [],
      createdAt: `2026-${String(1 + (i % 10)).padStart(2, '0')}-0${1 + (i % 9)}T10:00:00.000Z`,
      statusHistory: reason ? [{ from: 'regular', to: value, reason, at: NOW, by: ADMIN_REF }] : [],
    };
    families.push(family);
    const childCount = 1 + (i % 3);
    for (let c = 0; c < childCount; c++) {
      const name = `${CHILD_NAMES[(i + c * 5) % CHILD_NAMES.length]} ${parentName.split(' ').pop()}`;
      const teacherId = isDemoParent || i % 4 === 0 ? 1 : 2 + ((i + c) % 6);
      const inactive = value === 'deactivated' || (i === 3 && c === 1);
      const id = studentId++;
      students.push({
        id,
        familyId: i,
        family: { id: i, parentName, countryCode: place.country, timezone: place.tz },
        name: isDemoParent ? (['Ali', 'Mariam'][c] ?? name) : name,
        email: null,
        gender: (i + c) % 2 ? 'male' : 'female',
        age: 6 + ((i + c) % 9),
        language: (['english', 'arabic', 'urdu'] as const)[(i + c) % 3] ?? null,
        regularCourse: courseRef(1 + ((i + c) % 3)),
        additionalCourse: (i + c) % 4 === 0 ? courseRef(4) : null,
        teacher: { id: teacherId, name: teachers[teacherId - 1]!.name },
        startDate: family.startDate,
        zoomId: null,
        remarkParent: null,
        remarkTeacher: null,
        status: inactive ? status('inactive', 'Family deactivated') : status('active'),
        archive: archived ? family.archive : null,
        createdAt: family.createdAt,
        statusHistory: [],
      });
    }
  }

  const role = {
    owner: staffRole('admin', 'المالك (مدير النظام)', 'Owner (super admin)', 1, 'owner'),
    manager: staffRole('manager', 'مدير', 'Manager', 3),
    monitor: staffRole('monitor', 'مشرف متابعة', 'Monitor', 4),
    csr: staffRole('csr', 'خدمة العملاء', 'Customer service', 5),
    billing: staffRole('billing', 'الفوترة', 'Billing', 6),
    accounts: staffRole('accounts', 'الحسابات', 'Accounts', 7),
  };
  const staffRow = (
    id: number,
    name: string,
    email: string,
    r: StaffDto['role'],
    inactive = false,
  ): StaffRow => ({
    id,
    name,
    email,
    phone: `+2010000001${String(id).padStart(2, '0')}`,
    role: r,
    timezone: 'Africa/Cairo',
    locale: 'ar',
    status: inactive ? status('inactive', 'Contract ended') : status('active'),
    archive: null,
    createdAt: '2026-01-05T08:00:00.000Z',
    statusHistory: inactive
      ? [{ from: 'active', to: 'inactive', reason: 'Contract ended', at: NOW, by: ADMIN_REF }]
      : [],
  });
  const staff: StaffRow[] = [
    staffRow(1, 'مدير النظام', 'admin@qarabic.test', role.owner),
    staffRow(4, 'مشرف تجريبي', 'supervisor@qarabic.test', SUPERVISOR_ROLE),
    staffRow(11, 'Sherif Manager', 'sherif.manager@example.com', role.manager),
    staffRow(12, 'Rana Monitor', 'rana.monitor@example.com', role.monitor),
    staffRow(13, 'Mona CSR', 'mona.csr@example.com', role.csr),
    staffRow(14, 'Hesham Billing', 'hesham.billing@example.com', role.billing),
    staffRow(15, 'Laila Accounts', 'laila.accounts@example.com', role.accounts),
    staffRow(16, 'Walid Former', 'walid.former@example.com', role.monitor, true),
  ];

  const db: Db = {
    families,
    students,
    teachers,
    staff,
    nextId: { families: 100, students: 200, teachers: 50, staff: 50 },
  };
  syncDerived(db);
  return db;
}

/** Children on the family rows and live student counts on the teacher rows. */
export function syncDerived(db: Db) {
  for (const family of db.families) {
    family.students = db.students
      .filter((s) => s.familyId === family.id && (family.archive ? true : !s.archive))
      .map((s) => ({ id: s.id, name: s.name, status: s.status.value }));
  }
  for (const teacher of db.teachers) {
    teacher.activeStudents = db.students.filter(
      (s) => s.teacher?.id === teacher.id && s.status.value === 'active' && !s.archive,
    ).length;
  }
  for (const student of db.students) {
    const family = db.families.find((f) => f.id === student.familyId);
    if (family) {
      student.family = {
        id: family.id,
        parentName: family.parentName,
        countryCode: family.countryCode,
        timezone: family.timezone,
      };
    }
    if (student.teacher) {
      const t = db.teachers.find((x) => x.id === student.teacher!.id);
      if (t) student.teacher = { id: t.id, name: t.name };
    }
  }
}

export let db: Db = build();

export function resetPeopleDb() {
  db = build();
}

export const ACTIVE = ACTIVE_STATUSES;
export const COUNTRIES = countryList();
