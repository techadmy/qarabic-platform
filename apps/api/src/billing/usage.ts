import { Injectable } from '@nestjs/common';
import type { PackageUsageDto } from '@qarabic/shared';
import type { Invoice, InvoiceLine } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, fromDbDate, startOfLocalDay } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';

const NOT_COUNTED = ['leave', 'cancelled', 'moved_out'];
const UPCOMING = ['scheduled', 'activated', 'in_progress', 'ended'];

/**
 * Package usage per child for an invoice period (Laravel `PackageUsageService`, B24, D85).
 * Information only: money never changes automatically. Allowance = classes per week × 4;
 * "counted" = the stages in `billing.deducting_stages`.
 */
@Injectable()
export class PackageUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async forInvoice(
    invoice: Pick<Invoice, 'periodStart' | 'periodEnd'>,
    lines: Array<InvoiceLine & { student: { id: number; name: string } | null }>,
  ): Promise<PackageUsageDto[]> {
    if (!invoice.periodStart || !invoice.periodEnd) return [];
    const st = await this.settings.all();
    const zone = st['academy.timezone'];
    const from = new Date(startOfLocalDay(fromDbDate(invoice.periodStart), zone));
    const to = new Date(startOfLocalDay(addDays(fromDbDate(invoice.periodEnd), 1), zone));
    const counted = st['billing.deducting_stages'].map(String);
    const out: PackageUsageDto[] = [];
    for (const line of lines) {
      if (line.type !== 'package' || !line.studentId) continue;
      const groups = await this.prisma.classSession.groupBy({
        by: ['stage'],
        where: { studentId: line.studentId, deletedAt: null, startsAt: { gte: from, lt: to } },
        _count: { _all: true },
      });
      const byStage = Object.fromEntries(groups.map((g) => [g.stage, g._count._all])) as Record<
        string,
        number
      >;
      const sum = (stages: string[]) => stages.reduce((n, s) => n + (byStage[s] ?? 0), 0);
      const meta = (line.meta ?? {}) as Record<string, unknown>;
      out.push({
        studentId: line.studentId,
        studentName: line.student?.name ?? '',
        allowance: Number(meta.classesPerWeek ?? 0) * 4,
        counted: sum(counted),
        notCounted: sum(NOT_COUNTED),
        upcoming: sum(UPCOMING),
        byStage,
        countedStages: counted,
      });
    }
    return out;
  }
}
