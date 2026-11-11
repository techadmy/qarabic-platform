import type { PrismaClient } from '../src/generated/prisma/client.js';

const DEMO_DOMAIN = 'demo.qarabic.test';

/**
 * Development only (fake data, no real money): three fee packages priced in a few currencies, a
 * billing profile for every demo family (alternating USD / GBP, billing on the 1st), a package for
 * every demo child, and this month's invoice for the first two families (one open, one paid in
 * cash) plus a CSR draft. Payment providers stay off (no keys); parent emails stay off
 * (`billing.notify_parents`). Skipped when packages exist.
 */
export async function seedDemoBilling(prisma: PrismaClient): Promise<boolean> {
  if ((await prisma.feePackage.count()) > 0) return false;
  const families = await prisma.family.findMany({
    where: { user: { email: { endsWith: `@${DEMO_DOMAIN}` } }, archivedAt: null },
    include: { students: { where: { archivedAt: null }, orderBy: { id: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  if (!families.length) return false;

  const packages = [];
  for (const [name, perWeek, prices] of [
    ['يومان في الأسبوع — 30 دقيقة', 2, { USD: '60.00', GBP: '50.00', EUR: '55.00', CAD: '80.00' }],
    [
      '3 أيام في الأسبوع — 30 دقيقة',
      3,
      { USD: '90.00', GBP: '75.00', EUR: '82.00', CAD: '120.00' },
    ],
    ['5 أيام في الأسبوع — 30 دقيقة', 5, { USD: '140.00', GBP: '115.00' }],
  ] as const) {
    packages.push(
      await prisma.feePackage.create({
        data: {
          name,
          classesPerWeek: perWeek,
          sessionMinutes: 30,
          prices: {
            create: Object.entries(prices).map(([currency, monthlyAmount]) => ({
              currency,
              monthlyAmount,
            })),
          },
        },
        include: { prices: true },
      }),
    );
  }

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const year = Number(month.slice(0, 4));
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  const due = new Date(`${month}-07T00:00:00Z`);
  let number = 0;

  for (const [i, family] of families.entries()) {
    const currency = i % 2 === 0 ? 'USD' : 'GBP';
    await prisma.familyBillingProfile.create({
      data: { familyId: family.id, currency, billingDay: 1, enabled: true },
    });
    const lines: Array<{
      studentId: number;
      feePackageId: number;
      description: string;
      amount: string;
      perWeek: number;
    }> = [];
    for (const [k, student] of family.students.entries()) {
      const pkg = packages[k % 2]!;
      await prisma.studentFeePackage.create({
        data: { studentId: student.id, feePackageId: pkg.id },
      });
      const price = pkg.prices.find((p) => p.currency === currency)!;
      lines.push({
        studentId: student.id,
        feePackageId: pkg.id,
        description: `${student.name} — ${pkg.name}`,
        amount: price.monthlyAmount.toFixed(2),
        perWeek: pkg.classesPerWeek,
      });
    }
    if (i > 1 || !lines.length) continue;

    const total = lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
    const amount = (total / 100).toFixed(2);
    number += 1;
    const invoice = await prisma.invoice.create({
      data: {
        familyId: family.id,
        kind: 'monthly',
        status: i === 1 ? 'paid' : 'issued',
        number: `INV-${year}-${String(number).padStart(6, '0')}`,
        periodStart: start,
        periodEnd: end,
        periodKey: `family:${family.id}:${month}-01`,
        currency,
        subtotal: amount,
        total: amount,
        paid: i === 1 ? amount : '0.00',
        issueDate: start,
        dueDate: due,
        issuedAt: start,
        paidAt: i === 1 ? now : null,
        lines: {
          create: lines.map((l) => ({
            type: 'package' as const,
            studentId: l.studentId,
            feePackageId: l.feePackageId,
            description: l.description,
            amount: l.amount,
            meta: { source: 'package', classesPerWeek: l.perWeek, sessionMinutes: 30 },
          })),
        },
      },
    });
    await prisma.billingEvent.create({
      data: {
        type: 'invoice.issued',
        subjectType: 'invoice',
        subjectId: invoice.id,
        familyId: family.id,
        amount,
        currency,
        occurredAt: start,
        payload: { number: invoice.number, kind: 'monthly' },
      },
    });
    if (i === 1) {
      const payment = await prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          familyId: family.id,
          method: 'cash',
          status: 'succeeded',
          amount,
          currency,
          reference: 'DEMO-1',
          receivedAt: now,
        },
      });
      await prisma.billingEvent.create({
        data: {
          type: 'payment.succeeded',
          subjectType: 'payment',
          subjectId: payment.id,
          familyId: family.id,
          amount,
          currency,
          occurredAt: now,
          payload: { invoiceId: invoice.id, method: 'cash' },
        },
      });
    } else {
      await prisma.invoice.create({
        data: {
          familyId: family.id,
          kind: 'manual',
          status: 'draft',
          currency,
          subtotal: '15.00',
          total: '15.00',
          notes: 'Placement test (draft by customer service)',
          lines: {
            create: [{ type: 'manual', description: 'اختبار تحديد المستوى', amount: '15.00' }],
          },
        },
      });
    }
  }
  await prisma.invoiceSequence.create({ data: { year, lastNumber: number } });
  return true;
}
