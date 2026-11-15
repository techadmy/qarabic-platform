import { z } from 'zod';
import { dateOnlySchema } from './people.js';
import { SESSION_KINDS } from './sessions.js';

type Labels<T extends string> = Record<T, { ar: string; en: string }>;

/*
| A1 teacher availability (docs/42 §4, D148; B131 = staff approval). A teacher's change to their
| own work hours or blocks waits for staff with `schedule.manage`; staff edits apply directly.
| Work hours apply from `effectiveFrom` (the teacher's local date); a block change on approval.
*/

export const AVAILABILITY_CHANGE_KINDS = [
  'work_hours',
  'block_create',
  'block_update',
  'block_delete',
] as const;
export type AvailabilityChangeKind = (typeof AVAILABILITY_CHANGE_KINDS)[number];

/** `approved` = waiting for its effective date; `applied` = in force. */
export const AVAILABILITY_CHANGE_STATUSES = [
  'pending',
  'approved',
  'applied',
  'rejected',
  'withdrawn',
] as const;
export type AvailabilityChangeStatus = (typeof AVAILABILITY_CHANGE_STATUSES)[number];

export const AVAILABILITY_CHANGE_KIND_LABELS: Labels<AvailabilityChangeKind> = {
  work_hours: { ar: 'تعديل ساعات العمل', en: 'Work hours change' },
  block_create: { ar: 'إضافة فترة غير متاحة', en: 'New unavailable time' },
  block_update: { ar: 'تعديل فترة غير متاحة', en: 'Unavailable time change' },
  block_delete: { ar: 'حذف فترة غير متاحة', en: 'Unavailable time removed' },
};
export const AVAILABILITY_CHANGE_STATUS_LABELS: Labels<AvailabilityChangeStatus> = {
  pending: { ar: 'بانتظار الاعتماد', en: 'Pending approval' },
  approved: { ar: 'معتمد (يسري لاحقًا)', en: 'Approved (from a later date)' },
  applied: { ar: 'مطبَّق', en: 'Applied' },
  rejected: { ar: 'مرفوض', en: 'Rejected' },
  withdrawn: { ar: 'مسحوب', en: 'Withdrawn' },
};

/** A booked class that the change would leave outside the teacher's hours (or inside a block). */
export const affectedClassSchema = z.object({
  id: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  kind: z.enum(SESSION_KINDS),
  student: z.object({ id: z.number().int(), name: z.string() }),
});
export type AffectedClassDto = z.infer<typeof affectedClassSchema>;

export const availabilityChangeSchema = z.object({
  id: z.number().int(),
  teacher: z.object({ id: z.number().int(), name: z.string(), timezone: z.string() }),
  kind: z.enum(AVAILABILITY_CHANGE_KINDS),
  status: z.enum(AVAILABILITY_CHANGE_STATUSES),
  /** The block a block_update / block_delete is about. */
  blockId: z.number().int().nullable(),
  /** What was asked: `{ workHours: [...] }` or the block fields. */
  payload: z.record(z.string(), z.unknown()),
  /** The teacher's local date the new hours start (work hours). */
  effectiveFrom: z.string(),
  note: z.string().nullable(),
  requestedBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  requestedAt: z.string(),
  decidedBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  appliedAt: z.string().nullable(),
  /** Booked classes (next 60 days from `effectiveFrom`) the change would conflict with. */
  affected: z.array(affectedClassSchema),
  can: z.object({ approve: z.boolean(), reject: z.boolean(), withdraw: z.boolean() }),
});
export type AvailabilityChangeDto = z.infer<typeof availabilityChangeSchema>;

/** `GET /availability-changes?status&teacherId` (staff: schedule.view; a teacher: their own). */
export const availabilityChangeQuerySchema = z.object({
  status: z.enum(AVAILABILITY_CHANGE_STATUSES).optional(),
  teacherId: z.coerce.number().int().positive().optional(),
});

/** Sent with a teacher's own PUT work-hours / block edit (optional). */
export const availabilityRequestFieldsSchema = z.object({
  effectiveFrom: dateOnlySchema.optional(),
  note: z.string().trim().max(500).optional(),
});

/** `POST /availability-changes/:id/approve` (`schedule.manage`; never one's own). */
export const approveAvailabilityChangeSchema = z.object({
  /** Change the start date (work hours); default: the requested one, or today if it passed. */
  effectiveFrom: dateOnlySchema.optional(),
  note: z.string().trim().max(500).optional(),
});

/** `POST /availability-changes/:id/reject` (`schedule.manage`): a reason is required. */
export const rejectAvailabilityChangeSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
