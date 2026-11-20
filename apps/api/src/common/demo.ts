import { Prisma } from '../generated/prisma/client.js';

/*
| D153: permanent demo accounts (a teacher, a parent and their students) that the owner logs in as
| on production for manual tests. They are ordinary records whose login has `users.is_demo`; the
| family, its students and the teacher profile are demo through that login. They stay in the normal
| lists and on the Today board, and are left out of the management numbers, payroll, invoicing,
| billing reminders and outbound mail.
*/

/** Every demo login lives on this domain (`.test` never resolves, so nothing can be delivered). */
export const DEMO_EMAIL_DOMAIN = 'demo.qarabic.test';

export function isDemoEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

// ------------------------------------------------------------------ Prisma filters

/** A family / teacher / pay profile whose login is not a demo one. */
export const NOT_DEMO_LOGIN = { user: { isDemo: false } } as const;

/** A student (or a row with a `student` relation) outside demo families. */
export const NOT_DEMO_STUDENT = { family: NOT_DEMO_LOGIN } as const;

/** A class session, request or row that has both a student and a teacher. */
export const NOT_DEMO_SESSION = {
  student: NOT_DEMO_STUDENT,
  teacher: NOT_DEMO_LOGIN,
} as const;

/** A row with a `family` relation (invoice, payment, credit). */
export const NOT_DEMO_FAMILY_ROW = { family: NOT_DEMO_LOGIN } as const;

// ------------------------------------------------------------------ SQL fragments

/** Column names are fixed strings from this codebase, never input. */
const col = (column: string) => Prisma.raw(column);

/** `column` (a student id) is not a demo family's student. */
export function notDemoStudentSql(column: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM students ds JOIN families df ON df.id = ds.family_id JOIN users du ON du.id = df.user_id
     WHERE ds.id = ${col(column)} AND du.is_demo)`;
}

/** `column` (a teacher id) is not the demo teacher. */
export function notDemoTeacherSql(column: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM teachers dt JOIN users du ON du.id = dt.user_id
     WHERE dt.id = ${col(column)} AND du.is_demo)`;
}

/** `column` (a family id) is not a demo family. */
export function notDemoFamilySql(column: string): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM families df JOIN users du ON du.id = df.user_id
     WHERE df.id = ${col(column)} AND du.is_demo)`;
}

/** A `class_sessions` row (or `alias`) outside demo students and demo teachers. */
export function notDemoSessionSql(alias = 'class_sessions'): Prisma.Sql {
  return Prisma.sql`${notDemoStudentSql(`${alias}.student_id`)} AND ${notDemoTeacherSql(`${alias}.teacher_id`)}`;
}
