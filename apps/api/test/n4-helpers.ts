import type { CreateTicketInput } from '@qarabic/shared';
import { createTicketSchema } from '@qarabic/shared';
import type { Prisma } from '../src/generated/prisma/client.js';
import { TicketsService } from '../src/support/tickets.service.js';
import { authUser, type TestContext } from './helpers.js';

/* N4 factories (Laravel tests/Feature/Feedback/Helpers.php). */

/** A tiny valid PNG (1×1). */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A ticket filed through the service like the API does (Laravel `fbTicket`), then forced into the
 * given state. Default: a technical problem in the `sessions` area.
 */
export async function fbTicket(
  ctx: TestContext,
  reporter: { id: number },
  attributes: Prisma.TicketUncheckedUpdateInput = {},
  description = 'The board does not load after login',
  input: Partial<CreateTicketInput> = {},
) {
  const service = ctx.app.get(TicketsService);
  const body = createTicketSchema.parse({
    type: 'bug',
    description,
    context: { area: 'sessions' },
    ...input,
  });
  const id = await service.create(await authUser(ctx, reporter), body, 'in_app');
  if (Object.keys(attributes).length) {
    await ctx.prisma.ticket.update({ where: { id }, data: attributes });
  }
  return ctx.prisma.ticket.findUniqueOrThrow({ where: { id } });
}

/** Gives a system role extra permissions straight in the database (Spatie `givePermissionTo`). */
export async function grant(ctx: TestContext, roleName: string, permissions: string[]) {
  const role = await ctx.prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const perms = await ctx.prisma.permission.findMany({ where: { name: { in: permissions } } });
  await ctx.prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    skipDuplicates: true,
  });
}
