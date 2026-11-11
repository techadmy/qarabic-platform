import { Injectable } from '@nestjs/common';
import { countryList, type PeopleLookups } from '@qarabic/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { isOwner } from './people.common.js';

/** `GET /people/lookups`: pickers for the People forms (Laravel `PeopleController::lookups`). */
@Injectable()
export class LookupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async lookups(viewer: AuthUser): Promise<PeopleLookups> {
    const [courses, managers, teachers, roles, currency] = await Promise.all([
      this.prisma.course.findMany({ orderBy: [{ category: 'asc' }, { nameEn: 'asc' }] }),
      // Managers = active staff whose role can manage families (docs/29: by permission, not by
      // role name). The owner role always can.
      this.prisma.user.findMany({
        where: {
          isActive: true,
          archivedAt: null,
          role: {
            OR: [
              { kind: 'owner' },
              { kind: 'staff', permissions: { some: { permission: { name: 'families.manage' } } } },
            ],
          },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.teacher.findMany({
        where: { status: 'active', archivedAt: null },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      this.prisma.role.findMany({
        where: { kind: { in: isOwner(viewer) ? ['owner', 'staff'] : ['staff'] } },
        select: { id: true, name: true, labelAr: true, labelEn: true, kind: true },
        orderBy: { id: 'asc' },
      }),
      this.settings.get('payroll.default_currency'),
    ]);
    return {
      countries: countryList(),
      courses: courses.map((c) => ({
        id: c.id,
        nameAr: c.nameAr,
        nameEn: c.nameEn,
        category: c.category,
        isActive: c.isActive,
      })),
      managers,
      teachers: teachers.map((t) => ({
        id: t.id,
        name: [t.firstName, t.lastName].filter(Boolean).join(' '),
      })),
      staffRoles: roles.map((r) => ({ ...r, kind: r.kind as 'owner' | 'staff' })),
      payCurrencies: [currency],
      defaultPayCurrency: currency,
    };
  }
}
