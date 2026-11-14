import type { AdjustmentStatus, AdjustmentType, Permission } from '@qarabic/shared';
import { isFineWorkflow } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';

/** Holds at least one of the permissions. */
export const hasAny = (u: AuthUser, ...perms: Permission[]) =>
  perms.some((p) => u.permissions.has(p));

// ------------------------------------------------------------------ attendance and leave (D94)

/** Sees and acts on everyone's days and leave (else own only). */
export const managesAttendance = (u: AuthUser) => u.permissions.has('attendance.manage');

export const leaveCan = {
  view: (u: AuthUser, l: { userId: number }) => managesAttendance(u) || l.userId === u.id,
  /** P0-3 (B116): never one's own leave, whatever the permissions. */
  decide: (u: AuthUser, l?: { userId: number }) =>
    managesAttendance(u) && (l === undefined || l.userId !== u.id),
  /** Own pending request, or any pending / approved one with `attendance.manage`. */
  cancel: (u: AuthUser, l: { userId: number; status: string }) =>
    managesAttendance(u) || (l.userId === u.id && l.status === 'pending'),
};

// ------------------------------------------------------------------ adjustments (D91, docs/21 §6, §9)

/** May see everyone's adjustments of the fine workflow. */
export const seesAllFines = (u: AuthUser) =>
  hasAny(u, 'fines.request', 'fines.manage', 'fines.approve', 'payroll.manage');

/** May see everyone's adjustments of every type. */
export const seesAllTypes = (u: AuthUser) =>
  hasAny(u, 'payroll.manage', 'payroll.review', 'payroll.approve');

/**
 * The status a new adjustment gets when this user creates it, or null when not allowed. One made
 * for oneself is only ever `proposed`: someone else decides it (P0-3, B116).
 */
export function adjustmentStatusFor(
  u: AuthUser,
  type: AdjustmentType,
  targetUserId?: number,
): AdjustmentStatus | null {
  const status = statusByRole(u, type);
  return status && targetUserId === u.id ? 'proposed' : status;
}

function statusByRole(u: AuthUser, type: AdjustmentType): AdjustmentStatus | null {
  if (type === 'fine') {
    if (hasAny(u, 'fines.manage', 'fines.approve')) return 'approved';
    return u.permissions.has('fines.request') ? 'proposed' : null;
  }
  if (type === 'fine_reduction') {
    return hasAny(u, 'fines.manage', 'payroll.manage') ? 'approved' : null;
  }
  return u.permissions.has('payroll.manage') ? 'approved' : null;
}

type AdjustmentLike = {
  userId: number;
  type: AdjustmentType;
  status: AdjustmentStatus;
  createdById: number | null;
};

export const adjustmentCan = {
  /** Staff of the workflow, or the person for their own decided items (else 404). */
  view: (u: AuthUser, a: AdjustmentLike) =>
    seesAllTypes(u) ||
    (seesAllFines(u) && isFineWorkflow(a.type)) ||
    (a.userId === u.id && a.status !== 'proposed' && a.status !== 'rejected'),
  /** Approve or reject a proposed item; never one about oneself (P0-3). */
  decide: (u: AuthUser, a: AdjustmentLike) =>
    a.userId !== u.id &&
    (isFineWorkflow(a.type)
      ? u.permissions.has('fines.approve')
      : u.permissions.has('payroll.manage')),
  cancel: (u: AuthUser, a: AdjustmentLike) => {
    // P0-3: one's own items only as a withdrawal of one's own still-proposed item.
    if (a.userId === u.id) return a.status === 'proposed' && a.createdById === u.id;
    if (isFineWorkflow(a.type)) {
      // The monitor who proposed a fine may withdraw it while it is still proposed.
      if (a.status === 'proposed' && a.createdById === u.id) return true;
      return hasAny(u, 'fines.manage', 'fines.approve');
    }
    return u.permissions.has('payroll.manage');
  },
};

// ------------------------------------------------------------------ payslips (D92)

/** Payroll staff see every payslip; anyone else only their own approved ones (else 404). */
export const isPayrollStaff = (u: AuthUser) =>
  hasAny(u, 'payroll.manage', 'payroll.review', 'payroll.approve');

export const payslipCan = {
  view: (u: AuthUser, s: { userId: number; status: string }) =>
    isPayrollStaff(u) || (s.userId === u.id && s.status !== 'draft'),
};
