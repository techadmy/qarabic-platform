import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  CONFLICT_CODES,
  TRIAL_NOTIFICATION_LABELS,
  type assignTrialOfferSchema,
  type cancelTrialOfferSchema,
  type createTrialOfferSchema,
  type MyTrialOfferDto,
  type resendTrialOfferSchema,
  type TrialOfferDto,
} from '@qarabic/shared';
import { CronJob } from 'cron';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { Crypto } from '../common/crypto.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationCentre } from '../operations/notification-centre.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { zoneOr } from '../schedule/conflicts.js';
import { local } from '../schedule/time.js';
import { SettingsService } from '../settings/settings.service.js';
import { TRIAL_DEFAULT_MINUTES } from './crm.config.js';
import { localToUtc, TrialEligibility } from './eligibility.js';
import { crmError, leadTransition } from './errors.js';
import { LeadNotifier } from './notifier.js';
import { LeadTrialService } from './trial.service.js';

type Out<S extends z.ZodType> = z.output<S>;

const OPEN_LEAD = ['new', 'contacted', 'trial_scheduled', 'trial_done'];
/** A teacher who takes an offer accepts its soft warnings (their own hours, a holiday …). */
const SOFT = CONFLICT_CODES.filter(
  (c) =>
    ![
      'teacher_overlap',
      'student_overlap',
      'teacher_blocked',
      'teacher_inactive',
      'enrollment_inactive',
      'past_time',
    ].includes(c),
);
const iso = (d: Date) => d.toISOString();

const include = {
  course: { select: { id: true, nameAr: true, nameEn: true } },
  createdBy: { select: { id: true, name: true } },
  claimedTeacher: { select: { id: true, firstName: true, lastName: true } },
  teachers: {
    include: { teacher: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { teacherId: 'asc' }],
  },
  student: { select: { age: true, gender: true } },
  lead: { select: { id: true, parentName: true, assignedToId: true } },
} satisfies Prisma.TrialOfferInclude;
type Row = Prisma.TrialOfferGetPayload<{ include: typeof include }>;

const teacherName = (t: { firstName: string; lastName: string | null }) =>
  [t.firstName, t.lastName].filter(Boolean).join(' ');

/**
 * Open trial offers (T3, docs/33 §4.3). The CSR offers a trial to the eligible teachers (or a
 * shortlist of them); each gets a notice and a card. `first_accept`: the first teacher to accept
 * is booked — the claim is one conditional update, so two teachers can never both win, and the
 * booking re-checks eligibility and clashes at that moment. `volunteer`: teachers volunteer and
 * the CSR assigns one. Offers close at `expiresAt`; the CSR is told and books directly.
 */
@Injectable()
export class TrialOffers implements OnApplicationBootstrap {
  private readonly logger = new Logger(TrialOffers.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly crypto: Crypto,
    private readonly eligibility: TrialEligibility,
    private readonly trials: LeadTrialService,
    private readonly centre: NotificationCentre,
    private readonly notifier: LeadNotifier,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SCHEDULER_ENABLED) return;
    const job = CronJob.from({
      cronTime: '0 * * * * *',
      onTick: () => {
        this.expireDue().catch((error: unknown) =>
          this.logger.error('trial-offers:expire failed', error as Error),
        );
      },
    });
    this.registry.addCronJob('trial-offers:expire', job);
    job.start();
  }

  // ---------------------------------------------------------------- staff

  async create(
    leadId: number,
    input: Out<typeof createTrialOfferSchema>,
    actor: AuthUser,
  ): Promise<number> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw notFound();
    if (!OPEN_LEAD.includes(lead.status)) throw leadTransition();
    if (!lead.familyId) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_family', {
        errors: { studentId: ['Create the family account first.'] },
      });
    }
    const student = await this.prisma.student.findFirst({
      where: { id: input.studentId, familyId: lead.familyId },
      include: { family: { select: { timezone: true } } },
    });
    if (!student) throw notFound();
    if (!(await this.prisma.course.findUnique({ where: { id: input.courseId } }))) {
      throw validationError({ courseId: ['The selected course is invalid.'] });
    }
    const st = await this.settings.all();
    const familyZone = zoneOr(student.family.timezone, st['academy.timezone']);
    const startsAt = localToUtc(
      input.localDate,
      input.localTime,
      input.timezone ?? familyZone,
      'localTime',
    );
    const now = this.clock.nowMs();
    const latest = startsAt - st['crm.trial_offer_min_hours_before'] * 3_600_000;
    const expiresAt = Math.min(
      now + (input.expiresInMinutes ?? st['crm.trial_offer_expiry_minutes']) * 60_000,
      latest,
    );
    if (expiresAt < now + 15 * 60_000) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'offer_too_late', {
        errors: { localTime: ['Too close to the trial for an offer: book a teacher directly.'] },
      });
    }
    const minutes = input.durationMinutes ?? TRIAL_DEFAULT_MINUTES;
    const judged = await this.eligibility.evaluate(
      this.prisma,
      {
        studentId: student.id,
        courseId: input.courseId,
        startsAt,
        minutes,
        teacherGenderPref: lead.teacherGenderPref,
        studentAge: student.age,
        studentLanguage: student.language,
      },
      st,
    );
    const eligible = judged.filter((o) => o.eligible);
    let targets = eligible;
    if (input.audience === 'shortlist') {
      const wanted = new Set(input.teacherIds ?? []);
      targets = eligible.filter((o) => wanted.has(o.teacher.id));
      const outside = [...wanted].filter((tid) => !targets.some((o) => o.teacher.id === tid));
      if (outside.length) {
        throw validationError({
          teacherIds: [`Not eligible for this trial: ${outside.join(', ')}.`],
        });
      }
    }
    if (targets.length === 0) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_eligible_teachers');
    }

    const offerId = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.trialOffer.create({
          data: {
            leadId,
            studentId: student.id,
            courseId: input.courseId,
            startsAt: new Date(startsAt),
            durationMinutes: minutes,
            timezone: familyZone,
            policy: input.policy,
            audience: input.audience,
            expiresAt: new Date(expiresAt),
            meetingUrl: input.meetingUrl ? this.crypto.encrypt(input.meetingUrl) : null,
            note: input.note ?? null,
            createdById: actor.id,
            teachers: {
              create: targets.map((o) => ({ teacherId: o.teacher.id, rank: o.rank })),
            },
          },
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'trial_offer_created',
            subjectType: 'lead',
            subjectId: leadId,
            after: {
              offerId: row.id,
              studentId: student.id,
              courseId: input.courseId,
              startsAt: iso(row.startsAt),
              policy: input.policy,
              teacherIds: targets.map((o) => o.teacher.id),
              expiresAt: iso(row.expiresAt),
            },
          },
          tx,
        );
        return row.id;
      })
      .catch(rethrowOpenOffer);
    await this.notifyTeachers(offerId, 'trial_offer');
    return offerId;
  }

  async listForLead(leadId: number): Promise<TrialOfferDto[]> {
    if (!(await this.prisma.lead.findUnique({ where: { id: leadId }, select: { id: true } }))) {
      throw notFound();
    }
    const rows = await this.prisma.trialOffer.findMany({
      where: { leadId },
      include,
      orderBy: { id: 'desc' },
    });
    return rows.map((r) => this.dto(r));
  }

  async show(id: number): Promise<TrialOfferDto> {
    const row = await this.prisma.trialOffer.findUnique({ where: { id }, include });
    if (!row) throw notFound();
    return this.dto(row);
  }

  async cancel(id: number, input: Out<typeof cancelTrialOfferSchema>, actor: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const done = await tx.trialOffer.updateMany({
        where: { id, status: 'open' },
        data: { status: 'cancelled', closedAt: this.clock.now(), closedById: actor.id },
      });
      if (done.count === 0) await this.refuseClosed(id);
      const row = await tx.trialOffer.findUniqueOrThrow({ where: { id } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'trial_offer_cancelled',
          subjectType: 'lead',
          subjectId: row.leadId,
          after: { offerId: id, reason: input.reason ?? null },
        },
        tx,
      );
    });
  }

  /** Opens an expired (or still open) offer again with a new deadline, and tells the teachers. */
  async resend(id: number, input: Out<typeof resendTrialOfferSchema>, actor: AuthUser) {
    const row = await this.prisma.trialOffer.findUnique({ where: { id } });
    if (!row) throw notFound();
    if (row.status !== 'open' && row.status !== 'expired') {
      throw crmError(HttpStatus.CONFLICT, 'offer_closed', { data: { status: row.status } });
    }
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const expiresAt = Math.min(
      now + (input.expiresInMinutes ?? st['crm.trial_offer_expiry_minutes']) * 60_000,
      row.startsAt.getTime() - st['crm.trial_offer_min_hours_before'] * 3_600_000,
    );
    if (expiresAt < now + 15 * 60_000) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'offer_too_late');
    }
    await this.prisma
      .$transaction(async (tx) => {
        const done = await tx.trialOffer.updateMany({
          where: { id, status: { in: ['open', 'expired'] } },
          data: { status: 'open', expiresAt: new Date(expiresAt), expiryNotifiedAt: null },
        });
        if (done.count === 0) await this.refuseClosed(id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'trial_offer_resent',
            subjectType: 'lead',
            subjectId: row.leadId,
            after: { offerId: id, expiresAt: new Date(expiresAt).toISOString() },
          },
          tx,
        );
      })
      .catch(rethrowOpenOffer);
    await this.notifyTeachers(id, 'trial_offer', { skipDeclined: true });
  }

  /** The CSR books one of the offer's teachers (typically a volunteer). */
  async assign(id: number, input: Out<typeof assignTrialOfferSchema>, actor: AuthUser) {
    const target = await this.prisma.trialOfferTeacher.findUnique({
      where: { offerId_teacherId: { offerId: id, teacherId: input.teacherId } },
    });
    if (!(await this.prisma.trialOffer.findUnique({ where: { id }, select: { id: true } }))) {
      throw notFound();
    }
    if (!target) {
      throw validationError({ teacherId: ['This teacher was not offered this trial.'] });
    }
    return this.claimAndBook(id, input.teacherId, actor, input.acknowledgeWarnings, null);
  }

  // ---------------------------------------------------------------- teachers

  async mine(user: AuthUser): Promise<MyTrialOfferDto[]> {
    const teacher = await this.teacherOf(user);
    const st = await this.settings.all();
    const zone = zoneOr(teacher.timezone, st['academy.timezone']);
    const since = new Date(this.clock.nowMs() - 7 * 86_400_000);
    const rows = await this.prisma.trialOffer.findMany({
      where: {
        teachers: { some: { teacherId: teacher.id } },
        OR: [{ status: 'open' }, { updatedAt: { gte: since } }],
      },
      include: {
        course: { select: { id: true, nameAr: true, nameEn: true } },
        student: { select: { age: true, gender: true } },
        teachers: { where: { teacherId: teacher.id } },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const now = this.clock.nowMs();
    return rows.map((r) => {
      const at = local(r.startsAt.getTime(), zone);
      const open = r.status === 'open' && r.expiresAt.getTime() > now;
      const state: MyTrialOfferDto['state'] =
        r.status === 'claimed'
          ? r.claimedTeacherId === teacher.id
            ? 'mine'
            : 'taken'
          : open
            ? 'open'
            : 'closed';
      return {
        id: r.id,
        course: r.course,
        startsAt: iso(r.startsAt),
        durationMinutes: r.durationMinutes,
        teacherZone: zone,
        teacherLocal: { date: at.date, time: at.time },
        student: { age: r.student.age, gender: r.student.gender, level: null },
        note: r.note,
        policy: r.policy,
        state,
        expiresAt: iso(r.expiresAt),
        myResponse: r.teachers[0]?.response ?? null,
        sessionId: state === 'mine' ? r.sessionId : null,
      };
    });
  }

  /** Accept (or volunteer, by the offer's policy) or decline. */
  async respond(id: number, answer: 'accept' | 'decline', user: AuthUser): Promise<void> {
    const teacher = await this.teacherOf(user);
    const offer = await this.prisma.trialOffer.findUnique({
      where: { id },
      include: { teachers: { where: { teacherId: teacher.id } }, lead: true },
    });
    // Not offered to this teacher: as if it did not exist.
    if (!offer || offer.teachers.length === 0) throw notFound();
    const now = this.clock.nowMs();
    if (offer.status === 'claimed') {
      throw crmError(HttpStatus.CONFLICT, 'offer_taken');
    }
    if (offer.status !== 'open' || offer.expiresAt.getTime() <= now) {
      throw crmError(HttpStatus.CONFLICT, 'offer_closed', { data: { status: offer.status } });
    }
    if (answer === 'decline' || offer.policy === 'volunteer') {
      const response = answer === 'decline' ? 'decline' : 'volunteer';
      await this.prisma.trialOfferTeacher.update({
        where: { offerId_teacherId: { offerId: id, teacherId: teacher.id } },
        data: { response, respondedAt: this.clock.now() },
      });
      if (response === 'volunteer') {
        await this.tellCsr(offer, 'trial_offer_volunteer');
      }
      return;
    }
    // First to accept: the fairness guard, then the atomic claim and the booking.
    const st = await this.settings.all();
    const held = await this.prisma.trialOffer.count({
      where: {
        claimedTeacherId: teacher.id,
        status: 'claimed',
        session: { stage: 'scheduled', startsAt: { gt: new Date(now) }, deletedAt: null },
      },
    });
    if (held >= st['crm.trial_offer_max_open_claims']) {
      throw crmError(HttpStatus.CONFLICT, 'claim_limit', {
        data: { held, max: st['crm.trial_offer_max_open_claims'] },
      });
    }
    await this.claimAndBook(id, teacher.id, user, SOFT, user);
  }

  // ---------------------------------------------------------------- jobs

  /** Closes the offers past their deadline and tells the CSR, once each. */
  async expireDue(): Promise<number> {
    const now = this.clock.now();
    const due = await this.prisma.trialOffer.findMany({
      where: { status: 'open', expiresAt: { lte: now } },
      include,
      take: 200,
    });
    let expired = 0;
    for (const offer of due) {
      const done = await this.prisma.trialOffer.updateMany({
        where: { id: offer.id, status: 'open', expiresAt: { lte: now } },
        data: { status: 'expired', closedAt: now, expiryNotifiedAt: now },
      });
      if (done.count === 0) continue;
      expired++;
      await this.tellCsr(offer, 'trial_offer_expired');
    }
    return expired;
  }

  // ---------------------------------------------------------------- internals

  /**
   * One conditional update claims the offer for `teacherId`; then the trial is booked through the
   * normal booking (eligibility, clashes, rebooking). A failed booking re-opens the offer.
   */
  private async claimAndBook(
    id: number,
    teacherId: number,
    actor: AuthUser,
    acknowledge: readonly string[],
    claimer: AuthUser | null,
  ): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.prisma.trialOffer.updateMany({
      where: {
        id,
        status: 'open',
        ...(claimer ? { expiresAt: { gt: now } } : {}),
      },
      data: { status: 'claimed', claimedTeacherId: teacherId },
    });
    if (claimed.count === 0) {
      const row = await this.prisma.trialOffer.findUniqueOrThrow({ where: { id } });
      throw row.status === 'claimed'
        ? crmError(HttpStatus.CONFLICT, 'offer_taken')
        : crmError(HttpStatus.CONFLICT, 'offer_closed', { data: { status: row.status } });
    }
    const offer = await this.prisma.trialOffer.findUniqueOrThrow({
      where: { id },
      include: { lead: true },
    });
    const zone = offer.timezone;
    const at = local(offer.startsAt.getTime(), zone);
    let sessionId: number;
    try {
      sessionId = await this.trials.bookTrial(
        offer.leadId,
        {
          studentId: offer.studentId,
          courseId: offer.courseId,
          teacherId,
          localDate: at.date,
          localTime: at.time,
          timezone: zone,
          durationMinutes: offer.durationMinutes,
          meetingUrl: this.crypto.tryDecrypt(offer.meetingUrl),
          acknowledgeWarnings: [...acknowledge],
          overrideReason: null,
        },
        actor,
      );
    } catch (error) {
      await this.prisma.trialOffer.update({
        where: { id },
        data: { status: 'open', claimedTeacherId: null },
      });
      if (claimer && error instanceof ApiException) {
        const body = error.getResponse() as { code?: string; data?: unknown };
        if (
          body.code === 'teacher_not_eligible' ||
          body.code === 'schedule_conflict' ||
          body.code === 'warnings_not_acknowledged'
        ) {
          throw crmError(HttpStatus.CONFLICT, 'offer_unavailable', {
            data: { reason: body.code, detail: body.data ?? null },
          });
        }
      }
      throw error;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.trialOffer.update({
        where: { id },
        data: { sessionId, closedAt: this.clock.now(), closedById: actor.id },
      });
      if (claimer) {
        await tx.trialOfferTeacher.update({
          where: { offerId_teacherId: { offerId: id, teacherId } },
          data: { response: 'accept', respondedAt: this.clock.now() },
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'trial_offer_claimed',
          subjectType: 'lead',
          subjectId: offer.leadId,
          after: { offerId: id, teacherId, sessionId, by: claimer ? 'teacher' : 'staff' },
        },
        tx,
      );
    });
    if (claimer) await this.tellCsr(offer, 'trial_offer_claimed');
    return sessionId;
  }

  private async refuseClosed(id: number): Promise<never> {
    const row = await this.prisma.trialOffer.findUnique({ where: { id } });
    if (!row) throw notFound();
    throw crmError(HttpStatus.CONFLICT, 'offer_closed', { data: { status: row.status } });
  }

  private async teacherOf(user: AuthUser) {
    const teacher = await this.prisma.teacher.findUnique({ where: { userId: user.id } });
    if (!teacher) throw crmError(HttpStatus.FORBIDDEN, 'not_a_teacher');
    return teacher;
  }

  /** The lead's owner, else whoever made the offer. Only the parent's name (staff side). */
  private async tellCsr(
    offer: {
      leadId: number;
      createdById: number | null;
      lead: { parentName: string; assignedToId: number | null };
    },
    event: 'trial_offer_claimed' | 'trial_offer_volunteer' | 'trial_offer_expired',
  ) {
    const userId = offer.lead.assignedToId ?? offer.createdById;
    if (!userId) return;
    await this.notifier.deliver([
      { userId, event, leadId: offer.leadId, parentName: offer.lead.parentName },
    ]);
  }

  /** The offer card notice: course, time in the teacher's zone, the child's age and gender. */
  private async notifyTeachers(
    offerId: number,
    event: 'trial_offer',
    opts: { skipDeclined?: boolean } = {},
  ): Promise<void> {
    const offer = await this.prisma.trialOffer.findUniqueOrThrow({
      where: { id: offerId },
      include: {
        course: { select: { id: true, nameAr: true, nameEn: true } },
        student: { select: { age: true, gender: true } },
        teachers: {
          include: { teacher: { select: { userId: true, timezone: true } } },
        },
      },
    });
    const st = await this.settings.all();
    const label = TRIAL_NOTIFICATION_LABELS[event];
    for (const t of offer.teachers) {
      if (opts.skipDeclined && t.response === 'decline') continue;
      const zone = zoneOr(t.teacher.timezone, st['academy.timezone']);
      const at = local(offer.startsAt.getTime(), zone);
      const deadline = local(offer.expiresAt.getTime(), zone);
      const when = `${at.date} ${at.time} (${zone})`;
      await this.centre.send({
        userIds: [t.teacher.userId],
        kind: 'trial',
        event,
        data: {
          offerId,
          courseId: offer.course.id,
          course: offer.course.nameAr,
          startsAt: iso(offer.startsAt),
          teacherLocal: `${at.date} ${at.time}`,
          durationMinutes: offer.durationMinutes,
          studentAge: offer.student.age,
          studentGender: offer.student.gender,
          expiresAt: iso(offer.expiresAt),
        },
        email: {
          subject: `${label.ar} — ${label.en}`,
          text:
            `${label.ar}: ${offer.course.nameAr} — ${when} — ${offer.durationMinutes} دقيقة. الرد قبل ${deadline.date} ${deadline.time}\n` +
            `${label.en}: ${offer.course.nameEn} — ${when} — ${offer.durationMinutes} min. Answer before ${deadline.date} ${deadline.time}`,
        },
      });
    }
  }

  private dto(r: Row): TrialOfferDto {
    const at = local(r.startsAt.getTime(), r.timezone);
    return {
      id: r.id,
      leadId: r.leadId,
      studentId: r.studentId,
      course: r.course,
      startsAt: iso(r.startsAt),
      durationMinutes: r.durationMinutes,
      familyZone: r.timezone,
      familyLocal: { date: at.date, time: at.time },
      policy: r.policy,
      audience: r.audience as TrialOfferDto['audience'],
      status: r.status,
      expiresAt: iso(r.expiresAt),
      note: r.note,
      createdBy: r.createdBy,
      claimedTeacher: r.claimedTeacher
        ? { id: r.claimedTeacher.id, name: teacherName(r.claimedTeacher) }
        : null,
      sessionId: r.sessionId,
      closedAt: r.closedAt ? iso(r.closedAt) : null,
      teachers: r.teachers.map((t) => ({
        teacher: { id: t.teacher.id, name: teacherName(t.teacher) },
        rank: t.rank,
        response: t.response,
        respondedAt: t.respondedAt ? iso(t.respondedAt) : null,
      })),
      createdAt: iso(r.createdAt),
    };
  }
}

/** The partial unique index: one open offer per student. */
function rethrowOpenOffer(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw crmError(HttpStatus.CONFLICT, 'offer_open');
  }
  throw error;
}
