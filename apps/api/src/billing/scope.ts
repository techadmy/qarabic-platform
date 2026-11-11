import type { AuthUser } from '../auth/auth.types.js';
import { notFound } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { isParentViewer, isTeacherViewer, type Tx } from '../people/people.common.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Billing row scope (Laravel `InvoicePolicy`, D87): staff with the route permission see every
 * family; a parent only their own family and never a draft; a teacher nothing. Outside the scope
 * = 404 (never confirms that a row exists).
 */
export type BillingScope =
  { kind: 'staff' } | { kind: 'family'; familyId: number } | { kind: 'none' };

export async function billingScope(db: PrismaService | Tx, user: AuthUser): Promise<BillingScope> {
  if (isTeacherViewer(user)) return { kind: 'none' };
  if (isParentViewer(user)) {
    const family = await db.family.findUnique({ where: { userId: user.id }, select: { id: true } });
    return family ? { kind: 'family', familyId: family.id } : { kind: 'none' };
  }
  return { kind: 'staff' };
}

/** Invoices the viewer may see. */
export function invoiceScopeWhere(scope: BillingScope): Prisma.InvoiceWhereInput {
  if (scope.kind === 'none') return { id: -1 };
  if (scope.kind === 'family') return { familyId: scope.familyId, status: { not: 'draft' } };
  return {};
}

/** Staff-only actions on an invoice or a family's billing: a portal user gets 404. */
export function assertStaffScope(scope: BillingScope): void {
  if (scope.kind !== 'staff') throw notFound();
}

export function assertFamilyInScope(scope: BillingScope, familyId: number): void {
  if (scope.kind === 'none') throw notFound();
  if (scope.kind === 'family' && scope.familyId !== familyId) throw notFound();
}

/**
 * Whether `user` may attach this invoice to a support request (Laravel `canReference`): a family
 * its own issued invoices, staff with `invoices.view` any, a teacher never.
 * TODO(after rebase on N4): call this from `TicketsService.canReference` for `type === 'invoice'`.
 */
export async function canReferenceInvoice(
  db: PrismaService | Tx,
  user: AuthUser,
  invoiceId: number,
): Promise<boolean> {
  const scope = await billingScope(db, user);
  if (scope.kind === 'none') return false;
  if (scope.kind === 'staff' && !user.permissions.has('invoices.view')) return false;
  const row = await db.invoice.findFirst({
    where: { AND: [{ id: invoiceId }, invoiceScopeWhere(scope)] },
    select: { id: true },
  });
  return row !== null;
}
