import type { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { phoneDigits } from '../src/crm/spam.js';

const DEMO_DOMAIN = 'demo.qarabic.test';
const HOUR = 3_600_000;

/**
 * Development only: made-up leads across the pipeline (new, contacted with a follow-up, a
 * referral, a website entry, lost, spam, a job applicant) so the CRM screens have something to
 * show. Every name is invented; emails are on `demo.qarabic.test`, phones are fictional
 * (+44 7700 900xxx is Ofcom's drama range). Nothing is sent to anyone. Skipped when leads exist.
 */
export async function seedDemoCrm(prisma: PrismaClient): Promise<boolean> {
  if ((await prisma.lead.count()) > 0) return false;
  const csr = await prisma.user.findUnique({ where: { email: `csr@${DEMO_DOMAIN}` } });
  const referrer = await prisma.family.findFirst({
    where: { user: { email: { endsWith: `@${DEMO_DOMAIN}` } } },
    orderBy: { id: 'asc' },
  });
  const course = await prisma.course.findFirst({ orderBy: { id: 'asc' } });
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR);

  const leads: Array<Partial<Prisma.LeadUncheckedCreateInput> & { parentName: string }> = [
    {
      parentName: 'Umm Hamza (demo)',
      source: 'web_form',
      site: 'app_trial',
      email: `umm.hamza@${DEMO_DOMAIN}`,
      phone: '+447700900501',
      countryCode: 'GB',
      timezone: 'Europe/London',
      children: [
        { name: 'Hamza', age: 7, gender: 'male', ...(course ? { courseId: course.id } : {}) },
      ],
      preferredTimes: 'Sat, Sun · evening',
      preferredSchedule: { days: [6, 7], periods: ['evening'] },
      teacherGenderPref: 'female',
      heardFrom: 'instagram',
      status: 'new',
      createdAt: at(0.2),
    },
    {
      parentName: 'Abu Bilal (demo)',
      source: 'web_form',
      site: 'wpforms:4823',
      externalRef: 'wpforms:4823:demo-1',
      email: `abu.bilal@${DEMO_DOMAIN}`,
      phone: '+12025550142',
      countryCode: 'US',
      timezone: 'America/New_York',
      courseInterest: 'Quran for Kids',
      children: [{ age: 9 }, { age: 12 }],
      message: '[Course for: Your Kids · Children: 2 · Age: 9 and 12]',
      utm: { source: 'google', medium: 'cpc', page: 'https://qarabic.com/free-trial/' },
      status: 'new',
      createdAt: at(3),
    },
    {
      parentName: 'Sister Aisha (demo)',
      source: 'phone',
      phone: '+971500000601',
      countryCode: 'AE',
      timezone: 'Asia/Dubai',
      children: [{ name: 'Mariam', age: 10, gender: 'female' }],
      status: 'contacted',
      lastContactedAt: at(20),
      firstResponseAt: at(20),
      contactAttempts: 1,
      nextFollowUpAt: new Date(now + 2 * HOUR),
      createdAt: at(26),
    },
    {
      parentName: 'Umm Zaynab (demo)',
      source: 'referral',
      phone: '+447700900602',
      countryCode: 'GB',
      timezone: 'Europe/London',
      children: [{}, {}],
      referralFamilyId: referrer?.id ?? null,
      message: 'My neighbour, she asked about weekend classes.',
      status: 'new',
      createdAt: at(30),
    },
    {
      parentName: 'Brother Yunus (demo)',
      source: 'whatsapp',
      phone: '+61400000701',
      countryCode: 'AU',
      timezone: 'Australia/Sydney',
      children: [{ name: 'Idris', age: 6, gender: 'male' }],
      status: 'lost',
      lostReason: 'price',
      statusNote: 'Will come back after the holidays.',
      lastContactedAt: at(70),
      createdAt: at(96),
    },
    {
      parentName: 'Cheap SEO 4U',
      source: 'web_form',
      email: `seo@${DEMO_DOMAIN}`,
      message: 'cheap seo https://spam.example',
      timezone: 'Africa/Cairo',
      children: [],
      status: 'spam',
      spamScore: 80,
      spamFlags: ['link_or_html', 'odd_name'],
      createdAt: at(50),
    },
    {
      parentName: 'Ustadha Huda (demo)',
      source: 'web_form',
      email: `huda.teacher@${DEMO_DOMAIN}`,
      phone: '+201000000801',
      countryCode: 'EG',
      timezone: 'Africa/Cairo',
      message: 'I would like to apply as a Quran teacher.',
      children: [],
      status: 'job_applicant',
      createdAt: at(120),
    },
  ];

  for (const l of leads) {
    const createdAt = l.createdAt as Date;
    const assigned = l.status !== 'spam' && l.status !== 'job_applicant' && csr ? csr.id : null;
    const lead = await prisma.lead.create({
      data: {
        ...l,
        source: l.source ?? 'web_form',
        timezone: l.timezone ?? 'Africa/Cairo',
        phoneDigits: phoneDigits(l.phone ?? null),
        assignedToId: assigned,
        assignedAt: assigned ? createdAt : null,
        autoAssignedAt:
          assigned && l.source !== 'phone' && l.source !== 'whatsapp' ? createdAt : null,
        statusChangedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      },
    });
    await prisma.leadActivity.create({
      data: { leadId: lead.id, type: 'created', meta: { source: lead.source }, createdAt },
    });
    if (lead.status === 'contacted') {
      await prisma.leadActivity.create({
        data: {
          leadId: lead.id,
          type: 'call',
          callResult: 'reached',
          body: 'Spoke to the mother; she prefers Saturday mornings.',
          userId: assigned,
          createdAt: lead.lastContactedAt!,
        },
      });
    }
  }
  return true;
}
