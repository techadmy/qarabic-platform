import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type {
  bookTrialSchema,
  convertLeadSchema,
  createLeadAccountSchema,
  trialOutcomeSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AuthService } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PasswordsService } from '../auth/passwords.service.js';
import { Clock } from '../common/clock.js';
import { Crypto } from '../common/crypto.js';
import { notFound, validationError } from '../common/errors.js';
import { TRIAL_NOTIFICATION_LABELS, type TrialNotificationEvent } from '@qarabic/shared';
import { Prisma, type Lead } from '../generated/prisma/client.js';
import { recordStatusChange, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConflictChecker, zoneOr } from '../schedule/conflicts.js';
import { EnrollmentsService } from '../schedule/enrollments.service.js';
import { LIVE_ENROLLMENT } from '../schedule/scope.js';
import { addDays, local, maxDate, toDbDate, fromDbDate } from '../schedule/time.js';
import type { ResyncScope } from '../sessions/resync.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { Actor, SessionStateMachine } from '../sessions/state-machine.js';
import { ZoomDriver } from '../sessions/zoom.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationCentre } from '../operations/notification-centre.js';
import { TRIAL_DEFAULT_MINUTES } from './crm.config.js';
import { localToUtc, TrialEligibility } from './eligibility.js';
import { crmError, leadTransition } from './errors.js';
import { LeadService } from './lead.service.js';
import { Outbox } from './notifier.js';

type Out<S extends z.ZodType> = z.output<S>;

export { localToUtc } from './eligibility.js';

/**
 * Lead → family account → trial class → regular family (docs/26 §6, D109–D111). Port of Laravel
 * `LeadTrialService`. Scheduling goes through the N2 services, so conflicts, warnings and the
 * generator behave exactly as on the schedule screens.
 */
@Injectable()
export class LeadTrialService {
  private readonly logger = new Logger(LeadTrialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly leads: LeadService,
    private readonly checker: ConflictChecker,
    private readonly sessions: SessionsService,
    private readonly machine: SessionStateMachine,
    private readonly enrollments: EnrollmentsService,
    private readonly zoom: ZoomDriver,
    private readonly crypto: Crypto,
    private readonly passwords: PasswordsService,
    @Inject(AuthService) private readonly auth: AuthService,
    private readonly eligibility: TrialEligibility,
    private readonly centre: NotificationCentre,
  ) {}

  // ---------------------------------------------------------------- 6.1 account

  async createAccount(
    leadId: number,
    input: Out<typeof createLeadAccountSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const courseIds = [...new Set(input.children.map((c) => c.courseId))];
    const courses = await this.prisma.course.findMany({
      where: { id: { in: courseIds } },
      select: { id: true },
    });
    const known = new Set(courses.map((c) => c.id));
    const missing: Record<string, string[]> = {};
    input.children.forEach((c, i) => {
      if (!known.has(c.courseId))
        missing[`children.${i}.courseId`] = ['The selected course is invalid.'];
    });
    if (Object.keys(missing).length) throw validationError(missing);

    await this.leads
      .mutate(leadId, actor.id, 'account_created', async (tx, lead) => {
        if (lead.familyId) throw crmError(HttpStatus.CONFLICT, 'already_has_family');
        if (!['new', 'contacted', 'trial_scheduled', 'trial_done'].includes(lead.status)) {
          throw leadTransition();
        }
        let familyId: number;
        let created: boolean;
        if (input.familyId) {
          const family = await tx.family.findUnique({ where: { id: input.familyId } });
          if (!family || family.archivedAt) throw notFound();
          familyId = family.id;
          created = false;
        } else {
          familyId = await this.newFamily(tx, lead, input, actor);
          created = true;
        }
        const students: Array<{ id: number; name: string }> = [];
        for (const child of input.children) {
          const st = await tx.student.create({
            data: {
              familyId,
              name: child.name.trim(),
              age: child.age ?? null,
              gender: child.gender ?? null,
              regularCourseId: child.courseId,
            },
            select: { id: true, name: true },
          });
          students.push(st);
          await this.audit.record(
            {
              actorId: actor.id,
              action: 'created',
              subjectType: 'student',
              subjectId: st.id,
              after: { familyId, name: st.name, regularCourseId: child.courseId, leadId: lead.id },
            },
            tx,
          );
        }
        await this.leads.save(tx, lead.id, { family: { connect: { id: familyId } } });
        await this.leads.log(
          tx,
          lead.id,
          'account_created',
          null,
          { familyId, linkedExisting: !created, students },
          actor.id,
        );
      })
      .catch(rethrowEmailTaken);
  }

  /** A trial family with a parent login (random password; the parent sets one by reset link, D111). */
  private async newFamily(
    tx: Tx,
    lead: Lead,
    input: Out<typeof createLeadAccountSchema>,
    actor: AuthUser,
  ): Promise<number> {
    const email = input.email!.trim().toLowerCase();
    const existing = await tx.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, family: { select: { id: true } } },
    });
    if (existing) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'email_taken', {
        errors: { email: ['This email already has an account.'] },
        data: { familyId: existing.family?.id ?? null },
      });
    }
    const zone = input.timezone ?? lead.timezone;
    const role = await tx.role.findUniqueOrThrow({ where: { name: 'parent' } });
    const user = await tx.user.create({
      data: {
        name: input.parentName!.trim(),
        email,
        phone: input.phone ?? LeadService.e164(lead.phone),
        passwordHash: await this.passwords.hash(randomBytes(32).toString('base64url')),
        roleId: role.id,
        isActive: true,
        timezone: zone,
      },
      select: { id: true },
    });
    const family = await tx.family.create({
      data: {
        userId: user.id,
        timezone: zone,
        countryCode: input.countryCode ?? lead.countryCode,
        status: 'trial',
        managerId: lead.assignedToId ?? actor.id,
        statusChangedAt: this.clock.now(),
        statusChangedById: actor.id,
      },
      select: { id: true },
    });
    await recordStatusChange(tx, 'family', family.id, null, 'trial', null, actor.id);
    await this.audit.record(
      {
        actorId: actor.id,
        action: 'created',
        subjectType: 'family',
        subjectId: family.id,
        after: {
          parentName: input.parentName,
          email,
          timezone: zone,
          status: 'trial',
          leadId: lead.id,
        },
      },
      tx,
    );
    return family.id;
  }

  // ---------------------------------------------------------------- 6.2 trial

  /**
   * Books a trial class in the family's wall time. A rebooking moves the earlier still-scheduled
   * trial out (`moved_out` + `rescheduled`: unpaid, unbilled, docs/04). Returns the class id.
   */
  async bookTrial(
    leadId: number,
    input: Out<typeof bookTrialSchema>,
    actor: AuthUser,
  ): Promise<number> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw notFound();
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
    if (!(await this.prisma.teacher.findUnique({ where: { id: input.teacherId } }))) {
      throw validationError({ teacherId: ['The selected teacher is invalid.'] });
    }
    const st = await this.settings.all();
    const familyZone = zoneOr(student.family.timezone, st['academy.timezone']);
    const zone = input.timezone ?? familyZone;
    const startsAt = localToUtc(input.localDate, input.localTime, zone, 'localTime');
    if (startsAt <= this.clock.nowMs()) {
      throw validationError({ localTime: ['The trial class must be in the future.'] });
    }
    const minutes = input.durationMinutes ?? TRIAL_DEFAULT_MINUTES;
    const sessionUser = await Actor.of(this.prisma, actor);
    const outbox = new Outbox();
    let overridden: string[] = [];
    const cancelledFor: Array<{ sessionId: number; teacherId: number }> = [];

    const sessionId = await this.checker.locked([input.teacherId], [student.id], async (tx) => {
      const row = await this.leads.lockRow(tx, leadId);
      if (row.familyId !== lead.familyId) throw notFound();
      if (!['new', 'contacted', 'trial_scheduled', 'trial_done'].includes(row.status)) {
        throw leadTransition();
      }
      // T2: an ineligible teacher needs a reason (docs/33 §4.2); a clash stays a 409 below.
      const [judged] = await this.eligibility.evaluate(
        tx,
        {
          studentId: student.id,
          courseId: input.courseId,
          startsAt,
          minutes,
          teacherGenderPref: row.teacherGenderPref,
          studentAge: student.age,
          studentLanguage: student.language,
        },
        st,
        [input.teacherId],
      );
      overridden = (judged?.reasons ?? []).filter((r) => r !== 'busy');
      if (overridden.length && !input.overrideReason) {
        throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'teacher_not_eligible', {
          errors: { overrideReason: ['Give a reason to book a teacher who is not eligible.'] },
          data: { reasons: overridden },
        });
      }
      let enrollment = await tx.enrollment.findFirst({
        where: { studentId: student.id, courseId: input.courseId, ...LIVE_ENROLLMENT },
      });
      if (enrollment && enrollment.kind !== 'trial') {
        throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'already_enrolled', {
          errors: { courseId: ['The student is already enrolled in this course.'] },
        });
      }
      // A new trial, a new link, or a Zoom trial on a system without Zoom: (re)decide the link.
      const relink =
        !enrollment ||
        !!input.meetingUrl ||
        (enrollment.meetingMode === 'zoom' && !this.zoom.client.enabled());
      const meeting = relink
        ? await this.trialMeeting(tx, input.teacherId, input.meetingUrl ?? null, 'meetingUrl')
        : null;
      const now = this.clock.now();
      if (!enrollment) {
        enrollment = await tx.enrollment.create({
          data: {
            studentId: student.id,
            courseId: input.courseId,
            teacherId: input.teacherId,
            kind: 'trial',
            status: 'active',
            startsOn: toDbDate(local(startsAt, zone).date),
            sessionMinutes: minutes,
            timezone: familyZone,
            meetingMode: meeting!.meetingMode,
            externalMeetingUrl: meeting!.externalMeetingUrl,
            statusChangedAt: now,
            createdById: actor.id,
          },
        });
        await recordStatusChange(tx, 'enrollment', enrollment.id, null, 'active', null, actor.id);
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'created',
            subjectType: 'enrollment',
            subjectId: enrollment.id,
            after: {
              studentId: student.id,
              courseId: input.courseId,
              teacherId: input.teacherId,
              kind: 'trial',
              leadId,
            },
          },
          tx,
        );
      } else if (enrollment.teacherId !== input.teacherId || meeting) {
        // A rebooking can change the teacher, so the link follows the booking too.
        enrollment = await tx.enrollment.update({
          where: { id: enrollment.id },
          data: { teacherId: input.teacherId, ...(meeting ?? {}) },
        });
      }

      // Rebook: the previous still-scheduled trial of this student is moved out first (D109).
      const previous = await tx.classSession.findMany({
        where: { studentId: student.id, kind: 'trial', stage: 'scheduled', deletedAt: null },
        select: { id: true, teacherId: true },
        orderBy: { id: 'asc' },
      });
      for (const old of previous) {
        await this.machine.apply(
          old.id,
          'move',
          Actor.system(),
          { stageReason: 'rescheduled', note: 'trial_rebooked' },
          tx,
        );
        outbox.cancelledSessions.push(old.id);
        if (old.teacherId !== input.teacherId) {
          cancelledFor.push({ sessionId: old.id, teacherId: old.teacherId });
        }
        await this.leads.log(
          tx,
          leadId,
          'trial_cancelled',
          null,
          {
            sessionId: old.id,
            studentId: student.id,
          },
          actor.id,
        );
      }

      const id = await this.sessions.create(
        {
          enrollmentId: enrollment.id,
          teacherId: input.teacherId,
          kind: 'trial',
          startsAt: new Date(startsAt).toISOString(),
          durationMinutes: minutes,
          source: 'manual',
        },
        sessionUser,
        input.acknowledgeWarnings,
        { type: 'note', payload: { created: 'crm_trial', leadId } },
        tx,
      );
      await tx.family.update({
        where: { id: student.familyId },
        data: { trialDate: toDbDate(local(startsAt, zone).date) },
      });
      const teacher = await tx.teacher.findUniqueOrThrow({
        where: { id: input.teacherId },
        select: { timezone: true },
      });
      const teacherZone = zoneOr(teacher.timezone, st['academy.timezone']);
      await this.leads.moveTo(tx, row, 'trial_scheduled', actor.id);
      await this.leads.save(tx, leadId, { trialOutcome: null });
      const at = new Date(startsAt);
      await this.leads.log(
        tx,
        leadId,
        'trial_booked',
        null,
        {
          sessionId: id,
          studentId: student.id,
          studentName: student.name,
          teacherId: input.teacherId,
          startsAt: at.toISOString().replace('.000Z', 'Z'),
          familyLocal: `${local(startsAt, zone).date} ${local(startsAt, zone).time} ${zone}`,
          teacherLocal: `${local(startsAt, teacherZone).date} ${local(startsAt, teacherZone).time} ${teacherZone}`,
          rebooked: previous.length > 0,
          ...(overridden.length
            ? { eligibilityOverride: { reasons: overridden, reason: input.overrideReason } }
            : {}),
        },
        actor.id,
      );
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'trial_booked',
          subjectType: 'lead',
          subjectId: leadId,
          after: {
            sessionId: id,
            studentId: student.id,
            teacherId: input.teacherId,
            startsAt: at.toISOString(),
            ...(overridden.length
              ? { eligibilityOverride: { reasons: overridden, reason: input.overrideReason } }
              : {}),
          },
        },
        tx,
      );
      return id;
    });
    await this.leads.flush(outbox);
    await this.notifyTeacher('trial_booked', input.teacherId, sessionId);
    for (const c of cancelledFor)
      await this.notifyTeacher('trial_cancelled', c.teacherId, c.sessionId);
    return sessionId;
  }

  /**
   * Tells a teacher about a trial (kind `trial`): course, time in their zone, length, the child's
   * age and gender. Never the family's name or contacts (docs/33 §4.3).
   */
  private async notifyTeacher(
    event: TrialNotificationEvent,
    teacherId: number,
    sessionId: number,
  ): Promise<void> {
    const [teacher, session, st] = await Promise.all([
      this.prisma.teacher.findUnique({
        where: { id: teacherId },
        select: { userId: true, timezone: true },
      }),
      this.prisma.classSession.findUnique({
        where: { id: sessionId },
        select: {
          startsAt: true,
          durationMinutes: true,
          course: { select: { id: true, nameAr: true, nameEn: true } },
          student: { select: { age: true, gender: true } },
        },
      }),
      this.settings.all(),
    ]);
    if (!teacher || !session?.course) return;
    const course = session.course;
    const zone = zoneOr(teacher.timezone, st['academy.timezone']);
    const at = local(session.startsAt.getTime(), zone);
    const label = TRIAL_NOTIFICATION_LABELS[event];
    const age = session.student.age;
    const child = {
      ar: [session.student.gender === 'female' ? 'طالبة' : 'طالب', age ? `العمر ${age}` : null]
        .filter(Boolean)
        .join('، '),
      en: [session.student.gender ?? 'student', age ? `age ${age}` : null]
        .filter(Boolean)
        .join(', '),
    };
    const when = `${at.date} ${at.time} (${zone})`;
    await this.centre.send({
      userIds: [teacher.userId],
      kind: 'trial',
      event,
      data: {
        sessionId,
        courseId: course.id,
        course: course.nameAr,
        startsAt: session.startsAt.toISOString(),
        teacherLocal: `${at.date} ${at.time}`,
        durationMinutes: session.durationMinutes,
        studentAge: age,
        studentGender: session.student.gender,
      },
      email: {
        subject: `${label.ar} — ${label.en}`,
        text:
          `${label.ar}: ${course.nameAr} — ${when} — ${session.durationMinutes} دقيقة — ${child.ar}\n` +
          `${label.en}: ${course.nameEn} — ${when} — ${session.durationMinutes} min — ${child.en}`,
      },
    });
  }

  /**
   * How the trial class meets. Without Zoom (`ZOOM_DRIVER=none`) a Zoom trial would have no link
   * at class time, so it uses a fixed link: the one given with the booking, else the link the
   * teacher already uses for their regular classes, else 422 on `field`.
   */
  private async trialMeeting(
    tx: Tx,
    teacherId: number,
    url: string | null,
    field: string,
  ): Promise<{ meetingMode: 'zoom' | 'external'; externalMeetingUrl: string | null }> {
    if (url) return { meetingMode: 'external', externalMeetingUrl: this.crypto.encrypt(url) };
    if (this.zoom.client.enabled()) return { meetingMode: 'zoom', externalMeetingUrl: null };
    const teacherLink = await tx.enrollment.findFirst({
      where: { teacherId, meetingMode: 'external', externalMeetingUrl: { not: null } },
      orderBy: { id: 'desc' },
      select: { externalMeetingUrl: true },
    });
    if (!teacherLink?.externalMeetingUrl) {
      throw validationError({
        [field]: ['Zoom is not set up yet: enter the class link (Zoom or Google Meet).'],
      });
    }
    // Stored encrypted: the ciphertext is copied as is.
    return { meetingMode: 'external', externalMeetingUrl: teacherLink.externalMeetingUrl };
  }

  // ---------------------------------------------------------------- 6.3 outcome

  async recordOutcome(
    leadId: number,
    input: Out<typeof trialOutcomeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const outbox = new Outbox();
    await this.leads.mutate(
      leadId,
      actor.id,
      'trial_outcome',
      async (tx, lead) => {
        if (lead.status !== 'trial_scheduled' && lead.status !== 'trial_done')
          throw leadTransition();
        const note = input.note ?? null;
        await this.leads.save(tx, lead.id, { trialOutcome: input.outcome });
        await this.leads.log(
          tx,
          lead.id,
          'trial_outcome',
          note,
          { outcome: input.outcome },
          actor.id,
        );
        if (input.outcome === 'interested') {
          // T4 stale rule: a fresh «trial done» starts its clock again.
          await this.leads.save(tx, lead.id, { staleRemindedAt: null, staleLostSuggestedAt: null });
          await this.leads.moveTo(tx, lead, 'trial_done', actor.id);
        } else if (input.outcome === 'no_show') {
          await this.leads.moveTo(tx, lead, 'contacted', actor.id, { outcome: 'no_show' });
        } else {
          const lostReason = input.lostReason ?? 'not_interested';
          await this.leads.save(tx, lead.id, {
            lostReason,
            statusNote: note,
            nextFollowUpAt: null,
          });
          await this.leads.moveTo(tx, lead, 'lost', actor.id, { lostReason });
          await this.leads.cancelScheduledTrials(tx, lead, actor.id, outbox);
        }
      },
      outbox,
    );
  }

  // ---------------------------------------------------------------- 6.4 convert

  /**
   * One transaction (D110): a regular enrollment + weekly times per student in the family's
   * zone, the trial enrollment ends the day before, the family becomes `regular`, the lead
   * `converted`. Any conflict keeps nothing. Past trial classes keep their kind.
   */
  async convert(
    leadId: number,
    input: Out<typeof convertLeadSchema>,
    actor: AuthUser,
  ): Promise<number[]> {
    const st = await this.settings.all();
    const academy = st['academy.timezone'];
    const today = local(this.clock.nowMs(), academy).date;
    const errors: Record<string, string[]> = {};
    input.students.forEach((row, i) => {
      if (row.startsOn < today)
        errors[`students.${i}.startsOn`] = ['The start date is in the past.'];
    });
    if (Object.keys(errors).length) throw validationError(errors);

    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw notFound();
    if (!lead.familyId) {
      throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'no_family', {
        errors: { students: ['Create the family account first.'] },
      });
    }
    const familyId = lead.familyId;
    const students = await this.prisma.student.findMany({
      where: { id: { in: input.students.map((r) => r.studentId) }, familyId },
      include: { family: { select: { timezone: true } } },
    });
    if (students.length !== input.students.length) throw notFound();
    const byId = new Map(students.map((s) => [s.id, s]));
    for (const [i, row] of input.students.entries()) {
      if (!(await this.prisma.course.findUnique({ where: { id: row.courseId } }))) {
        errors[`students.${i}.courseId`] = ['The selected course is invalid.'];
      }
      if (!(await this.prisma.teacher.findUnique({ where: { id: row.teacherId } }))) {
        errors[`students.${i}.teacherId`] = ['The selected teacher is invalid.'];
      }
    }
    if (Object.keys(errors).length) throw validationError(errors);

    const scopes: ResyncScope[] = [];
    const created: number[] = [];
    let parentEmail: string | null = null;
    await this.checker.locked(
      input.students.map((r) => r.teacherId),
      students.map((s) => s.id),
      async (tx) => {
        const row = await this.leads.lockRow(tx, leadId);
        if (row.familyId !== familyId) throw notFound();
        if (!['new', 'contacted', 'trial_scheduled', 'trial_done'].includes(row.status)) {
          throw leadTransition();
        }
        const family = await tx.family.findUniqueOrThrow({
          where: { id: familyId },
          include: { user: { select: { email: true } } },
        });
        for (const [i, r] of input.students.entries()) {
          const student = byId.get(r.studentId)!;
          const zone = zoneOr(student.family.timezone, academy);
          const minutes = r.sessionMinutes ?? 30;
          const trials = await tx.enrollment.findMany({
            where: { studentId: student.id, kind: 'trial', ...LIVE_ENROLLMENT },
          });
          for (const trial of trials) {
            const endsOn = maxDate(addDays(r.startsOn, -1), fromDbDate(trial.startsOn));
            scopes.push(
              await this.enrollments.endInTx(tx, trial.id, endsOn, actor.id, 'converted'),
            );
          }
          const meeting = await this.regularMeeting(tx, r, trials, `students.${i}.meetingUrl`);
          const id = await this.enrollments.createIn(
            tx,
            {
              studentId: student.id,
              courseId: r.courseId,
              teacherId: r.teacherId,
              kind: 'regular',
              startsOn: r.startsOn,
              sessionMinutes: minutes,
              timezone: zone,
              meetingMode: meeting.meetingMode,
              externalMeetingUrl: meeting.url,
              notes: null,
              slots: r.slots.map((s) => ({
                weekday: s.weekday,
                localStartTime: s.localStartTime,
                durationMinutes: minutes,
              })),
              acknowledgeWarnings: input.acknowledgeWarnings,
            },
            student.id,
            zone,
            minutes,
            st,
            actor.id,
          );
          created.push(id);
          scopes.push({ enrollmentId: id });
          if (student.regularCourseId !== r.courseId || student.teacherId !== r.teacherId) {
            await tx.student.update({
              where: { id: student.id },
              data: { regularCourseId: r.courseId, teacherId: r.teacherId },
            });
          }
        }
        const now = this.clock.now();
        if (family.status !== 'regular') {
          await tx.family.update({
            where: { id: familyId },
            data: {
              status: 'regular',
              startDate: family.startDate ?? toDbDate(today),
              managerId: family.managerId ?? row.assignedToId ?? actor.id,
              statusChangedAt: now,
              statusChangedById: actor.id,
              statusReason: null,
            },
          });
          await recordStatusChange(
            tx,
            'family',
            familyId,
            family.status,
            'regular',
            null,
            actor.id,
          );
        }
        await this.leads.save(tx, leadId, {
          convertedAt: now,
          convertedBy: { connect: { id: actor.id } },
          nextFollowUpAt: null,
        });
        await this.leads.moveTo(tx, row, 'converted', actor.id);
        await this.leads.log(
          tx,
          leadId,
          'converted',
          null,
          {
            familyId,
            enrollmentIds: created,
            welcome: input.sendWelcome,
          },
          actor.id,
        );
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'converted',
            subjectType: 'lead',
            subjectId: leadId,
            before: { status: lead.status },
            after: { status: 'converted', familyId, enrollmentIds: created },
          },
          tx,
        );
        parentEmail = family.user.email;
      },
    );
    await this.enrollments.resyncAll(scopes);
    if (input.sendWelcome && parentEmail) {
      // A set-password link, never a password in mail (D111). Off unless asked for (D140).
      await this.auth.forgotPassword({ email: parentEmail });
    }
    return created;
  }

  /** The regular enrollment's meeting: the given link, Zoom when set up, else the trial's / teacher's link. */
  private async regularMeeting(
    tx: Tx,
    row: { teacherId: number; meetingUrl?: string | null },
    trials: Array<{ teacherId: number; meetingMode: string; externalMeetingUrl: string | null }>,
    field: string,
  ): Promise<{ meetingMode: 'zoom' | 'external'; url: string | null }> {
    if (row.meetingUrl) return { meetingMode: 'external', url: row.meetingUrl };
    if (this.zoom.client.enabled()) return { meetingMode: 'zoom', url: null };
    const sameTeacher = trials.find(
      (t) => t.teacherId === row.teacherId && t.meetingMode === 'external' && t.externalMeetingUrl,
    );
    const stored =
      sameTeacher?.externalMeetingUrl ??
      (await this.trialMeeting(tx, row.teacherId, null, field)).externalMeetingUrl;
    // `createIn` encrypts the plain link.
    return { meetingMode: 'external', url: this.crypto.tryDecrypt(stored) };
  }
}

/** The parent email lost a race at insert time: the same answer as the check. */
function rethrowEmailTaken(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta ?? {}).includes('email')
  ) {
    throw crmError(HttpStatus.UNPROCESSABLE_ENTITY, 'email_taken', {
      errors: { email: ['This email already has an account.'] },
    });
  }
  throw error;
}
