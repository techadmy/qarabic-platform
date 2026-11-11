import { categoryType, type TicketCategory, type TicketStatus } from '@qarabic/shared';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { SlaClock } from '../src/support/sla.js';
import { SUPPORT_SETTING_DEFAULTS as S } from '../src/support/settings-defaults.js';

const DEMO_DOMAIN = 'demo.qarabic.test';
const HOUR = 3_600_000;

interface DemoTicket {
  reporter: 'parent' | 'teacher' | 'monitor';
  category: TicketCategory;
  subcategory?: string;
  queue: 'scheduling' | 'billing' | 'complaints' | 'tech' | 'product' | 'general';
  status: TicketStatus;
  priority: 'p0' | 'p1' | 'p2' | 'p3' | null;
  hoursAgo: number;
  description: string;
  reply?: string;
}

/** Made-up requests covering every queue and status (Arabic, like real families write). */
const DEMO: DemoTicket[] = [
  {
    reporter: 'parent',
    category: 'classes',
    subcategory: 'schedule_change',
    queue: 'scheduling',
    status: 'new',
    priority: 'p2',
    hoursAgo: 1,
    description: 'نرجو نقل حصص يوم الثلاثاء إلى يوم الأربعاء في نفس الموعد بسبب مواعيد المدرسة.',
  },
  {
    reporter: 'parent',
    category: 'classes',
    subcategory: 'session_issue',
    queue: 'scheduling',
    status: 'new',
    priority: 'p1',
    hoursAgo: 30,
    description: 'لم يتمكن ابني من الدخول إلى الحصة أمس، وكان الرابط لا يعمل.',
  },
  {
    reporter: 'parent',
    category: 'billing',
    subcategory: 'invoice_question',
    queue: 'billing',
    status: 'in_progress',
    priority: 'p2',
    hoursAgo: 20,
    description: 'دفعت فاتورة الشهر الماضي ولكنها ما زالت تظهر غير مدفوعة.',
    reply: 'نراجع الدفعة مع البنك وسنعود إليكم خلال يوم عمل.',
  },
  {
    reporter: 'parent',
    category: 'teacher',
    subcategory: 'teacher_feedback',
    queue: 'complaints',
    status: 'triaged',
    priority: 'p1',
    hoursAgo: 5,
    description: 'المعلم يتأخر عن بداية الحصة باستمرار في الأسبوعين الأخيرين.',
  },
  {
    reporter: 'teacher',
    category: 'technical',
    queue: 'tech',
    status: 'needs_info',
    priority: 'p2',
    hoursAgo: 48,
    description: 'زر بدء الحصة لا يظهر على الهاتف.\nالمتصفح: Safari',
    reply: 'ما طراز الهاتف ونسخة النظام؟',
  },
  {
    reporter: 'monitor',
    category: 'suggestion',
    queue: 'product',
    status: 'fixed',
    priority: 'p3',
    hoursAgo: 120,
    description: 'اقتراح: إظهار عدد الحصص المتأخرة في أعلى لوحة اليوم.',
    reply: 'تمت إضافة العدّاد في التحديث الأخير، نرجو التأكيد.',
  },
  {
    reporter: 'parent',
    category: 'other',
    queue: 'general',
    status: 'verified',
    priority: 'p3',
    hoursAgo: 240,
    description: 'هل يمكن الحصول على شهادة إتمام لجزء عمّ؟',
    reply: 'نعم، سيرسلها المشرف بعد الاختبار.',
  },
];

/**
 * Development only: a handful of «تواصل معنا» tickets from the demo people, one per queue and
 * status, so the inbox, «طلباتي» and the CLI have something to show. Skipped when tickets exist or
 * there are no demo people. Every text is invented.
 */
export async function seedDemoSupport(prisma: PrismaClient): Promise<boolean> {
  if ((await prisma.ticket.count()) > 0) return false;
  const pick = (role: string) =>
    prisma.user.findFirst({
      where: { email: { endsWith: `@${DEMO_DOMAIN}` }, role: { name: role } },
      include: { family: { select: { id: true } }, teacher: { select: { id: true } } },
      orderBy: { id: 'asc' },
    });
  const people = {
    parent: await pick('parent'),
    teacher: await pick('teacher'),
    monitor: await pick('monitor'),
  };
  if (!people.parent || !people.teacher) return false;
  const staff = await prisma.user.findFirst({
    where: { email: { endsWith: `@${DEMO_DOMAIN}` }, role: { name: { in: ['csr', 'monitor'] } } },
    orderBy: { id: 'asc' },
  });
  const now = Date.now();
  const config = {
    slaHours: S['support.sla_hours'],
    workingHours: S['support.working_hours'],
  };
  for (const d of DEMO) {
    const reporter = people[d.reporter] ?? people.parent;
    const created = new Date(now - d.hoursAgo * HOUR);
    const closed = d.status === 'verified' || d.status === 'wont_fix';
    const ticket = await prisma.ticket.create({
      data: {
        channel: 'in_app',
        type: categoryType(d.category),
        category: d.category,
        subcategory: d.subcategory ?? null,
        queue: d.queue,
        visibility: d.queue === 'complaints' ? 'restricted' : 'normal',
        familyId: reporter.family?.id ?? null,
        teacherId:
          d.queue === 'complaints'
            ? (people.teacher.teacher?.id ?? null)
            : (reporter.teacher?.id ?? null),
        slaDueAt: new Date(SlaClock.dueFor(d.queue, created.getTime(), config)),
        firstResponseAt: d.reply ? new Date(created.getTime() + HOUR) : null,
        priority: d.priority,
        status: d.status,
        title: d.description.split('\n')[0]!.slice(0, 120),
        description: d.description,
        reporterId: reporter.id,
        reporterRole: d.reporter,
        context: { portal: d.reporter === 'parent' ? 'parent' : 'staff', area: 'demo' },
        triagedAt: d.status === 'new' ? null : created,
        fixedAt: d.status === 'fixed' || d.status === 'verified' ? created : null,
        verifiedAt: d.status === 'verified' ? created : null,
        closedAt: closed ? new Date(created.getTime() + 2 * HOUR) : null,
        lastPublicAt: new Date(created.getTime() + (d.reply ? HOUR : 0)),
        reporterSeenAt: created,
        // The demo monitor / CSR handle scheduling and general only (queue members).
        assigneeId:
          d.status !== 'new' && ['scheduling', 'general'].includes(d.queue)
            ? (staff?.id ?? null)
            : null,
        createdAt: created,
        updatedAt: new Date(created.getTime() + HOUR),
      },
    });
    if (d.reply) {
      await prisma.ticketComment.create({
        data: {
          ticketId: ticket.id,
          authorId: null,
          authorLabel: 'Claude',
          kind: 'comment',
          body: d.reply,
          createdAt: new Date(created.getTime() + HOUR),
        },
      });
    }
  }
  return true;
}
