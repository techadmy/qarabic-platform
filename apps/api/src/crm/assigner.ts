import { Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import type { Tx } from '../people/people.common.js';
import type { SettingsMap } from '../settings/settings.service.js';
import { usersWithPermission } from './notifier.js';
import { WorkingHours } from './working-hours.js';

export type PickReason = 'round_robin' | 'lead_admin' | 'disabled' | 'nobody';

/**
 * Who gets a new lead (docs/33 §3.2, B80, D136, D137). Port of Laravel `LeadAssigner`:
 * deterministic round-robin over the pool sorted by user id — the next user after the last
 * auto-assignee wins. Pool = active users with `leads.manage` (limited to
 * `crm.auto_assign_roles` when set) who are on shift (`crm.shift_source`: `any` = no shift limit
 * (D137, the default); `hours` = inside the CRM working hours; `attendance` = checked in — staff
 * attendance arrives with payroll (N6), so until then nobody counts as checked in). Staff leave
 * (N6) is not known yet either. Fallback: `crm.lead_admin_user_id`, else nobody.
 */
@Injectable()
export class LeadAssigner {
  constructor(private readonly clock: Clock) {}

  async pick(
    tx: Tx,
    s: SettingsMap,
  ): Promise<{ user: { id: number; name: string } | null; reason: PickReason }> {
    if (!s['crm.auto_assign_enabled']) return { user: null, reason: 'disabled' };
    const pool = await this.pool(tx, s);
    if (pool.length) {
      const last = await tx.lead.findFirst({
        where: { autoAssignedAt: { not: null }, assignedToId: { not: null } },
        orderBy: [{ autoAssignedAt: 'desc' }, { id: 'desc' }],
        select: { assignedToId: true },
      });
      const lastId = last?.assignedToId ?? 0;
      const next = pool.find((u) => u.id > lastId) ?? pool[0]!;
      return { user: next, reason: 'round_robin' };
    }
    const adminId = s['crm.lead_admin_user_id'];
    if (adminId > 0) {
      const [admin] = await usersWithPermission(tx, 'leads.manage', { id: adminId });
      if (admin) return { user: admin, reason: 'lead_admin' };
    }
    return { user: null, reason: 'nobody' };
  }

  async pool(tx: Tx, s: SettingsMap): Promise<Array<{ id: number; name: string }>> {
    const roles = s['crm.auto_assign_roles'].filter((r) => typeof r === 'string' && r !== '');
    const users = await usersWithPermission(
      tx,
      'leads.manage',
      roles.length ? { role: { name: { in: roles } } } : {},
    );
    if (!users.length) return [];
    switch (s['crm.shift_source']) {
      case 'hours':
        return WorkingHours.fromSettings(s).contains(this.clock.nowMs()) ? users : [];
      case 'attendance':
        return [];
      default:
        return users;
    }
  }
}
