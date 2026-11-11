import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CONTACT_ACTIVITY_TYPES,
  type assignLeadSchema,
  type bulkLeadStatusSchema,
  type createLeadSchema,
  isOpenLeadStatus,
  isParkedLeadStatus,
  type LeadActivityType,
  type leadActivityInputSchema,
  type LeadStatus,
  type leadStatusChangeSchema,
  OPEN_LEAD_STATUSES,
  type updateLeadSchema,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { ApiException, notFound, validationError } from '../common/errors.js';
import { ENV, type Env } from '../config/env.js';
import { Prisma, type Lead } from '../generated/prisma/client.js';
import type { Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ } from '../schedule/time.js';
import { Actor, SessionStateMachine } from '../sessions/state-machine.js';
import { ZoomMeetings } from '../sessions/zoom.js';
import { SettingsService } from '../settings/settings.service.js';
import { LeadAssigner } from './assigner.js';
import { DUPLICATE_WINDOW_DAYS } from './crm.config.js';
import { leadForbidden, leadTransition } from './errors.js';
import type { IntakeData, LeadChild } from './lead.types.js';
import { LeadNotifier, Outbox, usersWithPermission } from './notifier.js';
import { phoneDigits, scoreSpam, SPAM_THRESHOLD } from './spam.js';
import { zoneForCountry } from './zones.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const isContact = (type: string) => (CONTACT_ACTIVITY_TYPES as readonly string[]).includes(type);

/** Fields kept in the audit log of a lead (no IP hash). */
function snapshot(l: Lead): Record<string, unknown> {
  return {
    status: l.status,
    source: l.source,
    parentName: l.parentName,
    email: l.email,
    phone: l.phone,
    countryCode: l.countryCode,
    city: l.city,
    timezone: l.timezone,
    children: l.children,
    courseInterest: l.courseInterest,
    preferredTimes: l.preferredTimes,
    message: l.message,
    familyId: l.familyId,
    assignedToId: l.assignedToId,
    nextFollowUpAt: isoZ(l.nextFollowUpAt),
    trialOutcome: l.trialOutcome,
    lostReason: l.lostReason,
    statusNote: l.statusNote,
    convertedAt: isoZ(l.convertedAt),
    convertedById: l.convertedById,
  };
}

/** Thrown by a bulk row: reported in `failed`, the other rows go on. */
function codeOf(error: unknown): string | null {
  if (error instanceof ApiException) {
    const body = error.getResponse() as { code?: string };
    return body.code ?? 'error';
  }
  return null;
}

/**
 * Lead intake, edits, timeline, assignment and status (docs/26 §4–§5, docs/33 §3.2). Port of
 * Laravel `LeadService`: every mutation locks the lead row and leaves a timeline entry and an
 * audit row; staff alerts go out after the transaction commits.
 */
@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly assigner: LeadAssigner,
    private readonly notifier: LeadNotifier,
    private readonly machine: SessionStateMachine,
    private readonly zoom: ZoomMeetings,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---------------------------------------------------------------- intake

  /**
   * Public form, referral or the website webhook: spam-scored and merged into an open duplicate
   * (D107). With an `externalRef` the call is idempotent (`duplicate: true` on a replay).
   */
  async intake(
    raw: IntakeData,
    ip?: string | null,
  ): Promise<{ lead: Lead | null; merged: boolean; duplicate: boolean }> {
    const st = await this.settings.all();
    const data = this.normalise(raw, false, st['academy.timezone']);
    const ipHash = ip
      ? createHash('sha256').update(`${ip}|${this.env.SESSION_SECRET}`).digest('hex')
      : null;

    let result: { lead: Lead | null; merged: boolean; duplicate: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const keys = [
          data.externalRef ? `lead-ref:${data.externalRef}` : null,
          data.email ? `lead-intake:${data.email}` : null,
          data.phoneDigits ? `lead-intake:${data.phoneDigits}` : null,
        ].filter((k): k is string => k !== null);
        for (const key of keys.sort()) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        }
        if (data.externalRef && (await this.seen(tx, data.externalRef))) {
          return { lead: null, merged: false, duplicate: true };
        }
        const now = this.clock.now();

        const dup = await this.openDuplicate(tx, data.email ?? null, data.phoneDigits ?? null);
        if (dup) {
          await this.lockRow(tx, dup.id);
          const lead = await tx.lead.findUniqueOrThrow({ where: { id: dup.id } });
          const fill: Prisma.LeadUpdateInput = {
            submissions: lead.submissions + 1,
            updatedAt: now,
          };
          const blank = (v: unknown) => v === null || v === undefined || v === '';
          const fillable = [
            'phone',
            'phoneDigits',
            'email',
            'countryCode',
            'city',
            'courseInterest',
            'preferredTimes',
            'teacherGenderPref',
            'heardFrom',
          ] as const;
          for (const f of fillable) {
            if (blank(lead[f]) && !blank(data[f])) (fill as Record<string, unknown>)[f] = data[f];
          }
          if (lead.preferredSchedule === null && data.preferredSchedule) {
            fill.preferredSchedule = data.preferredSchedule;
          }
          if (lead.referralFamilyId === null && data.referralFamilyId) {
            fill.referralFamily = { connect: { id: data.referralFamilyId } };
          }
          const updated = await tx.lead.update({ where: { id: lead.id }, data: fill });
          await this.log(
            tx,
            lead.id,
            'resubmitted',
            data.message ?? null,
            compact({
              source: data.source,
              site: data.site,
              externalRef: data.externalRef,
            }),
            null,
          );
          return { lead: updated, merged: true, duplicate: false };
        }

        const recent = ipHash
          ? await tx.lead.count({
              where: { ipHash, createdAt: { gte: new Date(now.getTime() - HOUR) } },
            })
          : 0;
        const spam = scoreSpam(
          {
            parentName: data.parentName,
            email: data.email,
            phone: data.phone,
            message: data.message,
            courseInterest: data.courseInterest,
            preferredTimes: data.preferredTimes,
            city: data.city,
            children: data.children,
          },
          recent,
        );
        const isSpam = spam.score >= SPAM_THRESHOLD;
        const lead = await tx.lead.create({
          data: {
            ...this.createData(data),
            status: isSpam ? 'spam' : 'new',
            spamScore: spam.score,
            spamFlags: spam.flags.length ? spam.flags : Prisma.DbNull,
            ipHash,
            statusChangedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        });
        await this.log(
          tx,
          lead.id,
          'created',
          null,
          compact({
            source: lead.source,
            spam: isSpam ? spam.flags : null,
          }),
          null,
        );
        await this.audit.record(
          {
            actorId: null,
            action: 'created',
            subjectType: 'lead',
            subjectId: lead.id,
            after: snapshot(lead),
          },
          tx,
        );
        return { lead, merged: false, duplicate: false };
      });
    } catch (error) {
      // The unique external reference lost a race: the same answer as a replay.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        JSON.stringify(error.meta ?? {}).includes('external_ref')
      ) {
        return { lead: null, merged: false, duplicate: true };
      }
      throw error;
    }

    if (result.lead && !result.merged && result.lead.status === 'new') {
      result.lead = await this.autoAssign(result.lead.id);
    }
    return result;
  }

  /**
   * Round-robin among the pool, else the lead admin; nobody → the `leads.assign` holders are
   * told (docs/33 §3.2). A lead that already has an owner is left alone.
   */
  async autoAssign(leadId: number): Promise<Lead> {
    const outbox = new Outbox();
    const st = await this.settings.all();
    const lead = await this.prisma.$transaction(async (tx) => {
      // One assignment at a time, so two new leads never pick the same "next" person.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('lead-auto-assign'))`;
      const row = await this.lockRow(tx, leadId);
      if (row.assignedToId !== null) return row;
      const { user, reason } = await this.assigner.pick(tx, st);
      if (!user) {
        if (reason === 'nobody') await this.notifyAssigners(tx, row, 'unassigned', outbox);
        return row;
      }
      await this.applyAssignment(tx, row, user.id, null, outbox, { auto: reason });
      return tx.lead.update({
        where: { id: row.id },
        data: { autoAssignedAt: this.clock.now() },
      });
    });
    await this.flush(outbox);
    return lead;
  }

  /** Every active `leads.assign` holder (and `also`) hears about the lead once. */
  async notifyAssigners(
    tx: Tx,
    lead: Lead,
    event: 'unassigned' | 'sla_breach',
    outbox: Outbox,
    also: number | null = null,
    dueAt: string | null = null,
  ): Promise<void> {
    const holders = await usersWithPermission(tx, 'leads.assign');
    const ids = new Set(holders.map((u) => u.id));
    if (also) ids.add(also);
    const assignee = lead.assignedToId
      ? await tx.user.findUnique({ where: { id: lead.assignedToId }, select: { name: true } })
      : null;
    for (const userId of ids) {
      outbox.push({
        userId,
        event,
        leadId: lead.id,
        parentName: lead.parentName,
        dueAt,
        assignee: assignee?.name ?? null,
      });
    }
  }

  /** A lead typed by staff (call, WhatsApp, walk-in). Never merged: duplicates show on the workbench. */
  async createManual(input: z.output<typeof createLeadSchema>, actor: AuthUser): Promise<number> {
    const st = await this.settings.all();
    const data = this.normalise(input, false, st['academy.timezone']);
    const assignee = input.assignedTo === undefined ? actor.id : input.assignedTo;
    if (assignee !== null && assignee !== actor.id && !actor.permissions.has('leads.assign')) {
      throw leadForbidden();
    }
    const outbox = new Outbox();
    const id = await this.prisma.$transaction(async (tx) => {
      if (assignee !== null) await this.assertAssignable(tx, assignee);
      const now = this.clock.now();
      const lead = await tx.lead.create({
        data: {
          ...this.createData(data),
          nextFollowUpAt: input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null,
          status: 'new',
          createdById: actor.id,
          assignedToId: assignee,
          assignedAt: assignee ? now : null,
          statusChangedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.log(tx, lead.id, 'created', null, { source: lead.source }, actor.id);
      if (assignee !== null && assignee !== actor.id) {
        outbox.push({
          userId: assignee,
          event: 'assigned',
          leadId: lead.id,
          parentName: lead.parentName,
        });
      }
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'created',
          subjectType: 'lead',
          subjectId: lead.id,
          after: snapshot(lead),
        },
        tx,
      );
      return lead.id;
    });
    await this.flush(outbox);
    return id;
  }

  async update(
    id: number,
    input: z.output<typeof updateLeadSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const st = await this.settings.all();
    await this.mutate(id, actor.id, 'updated', async (tx, lead) => {
      const data = this.normalise(input, true, st['academy.timezone']);
      const patch: Prisma.LeadUpdateInput = {};
      for (const f of [
        'parentName',
        'email',
        'phone',
        'phoneDigits',
        'countryCode',
        'city',
        'timezone',
        'preferredLanguage',
        'courseInterest',
        'preferredTimes',
        'message',
      ] as const) {
        if (data[f] !== undefined) (patch as Record<string, unknown>)[f] = data[f];
      }
      if (data.children !== undefined) patch.children = data.children;
      if (input.nextFollowUpAt !== undefined) {
        patch.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
      }
      await this.save(tx, lead.id, patch);
    });
  }

  // ---------------------------------------------------------------- timeline

  async addActivity(
    id: number,
    input: z.output<typeof leadActivityInputSchema>,
    actor: AuthUser,
  ): Promise<number> {
    return this.mutate(id, actor.id, 'activity_added', async (tx, lead) => {
      const type = input.type;
      if (lead.status === 'converted' && !isContact(type) && type !== 'note') {
        throw leadTransition();
      }
      const activityId = await this.log(
        tx,
        lead.id,
        type,
        input.body ?? null,
        null,
        actor.id,
        input.callResult ?? null,
      );
      const patch: Prisma.LeadUpdateInput = {};
      if (isContact(type)) {
        const now = this.clock.now();
        patch.lastContactedAt = now;
        if (!lead.firstResponseAt) patch.firstResponseAt = now;
        patch.contactAttempts = lead.contactAttempts + 1;
        if (lead.status === 'new')
          await this.moveTo(tx, lead, 'contacted', actor.id, { auto: true });
      }
      if (input.nextFollowUpAt !== undefined) {
        patch.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : null;
      }
      await this.save(tx, lead.id, patch);
      return activityId;
    });
  }

  // ---------------------------------------------------------------- assignment

  /** Take a free lead (or release your own) with `leads.manage`; anyone else needs `leads.assign` (D108). */
  async assign(
    id: number,
    input: z.output<typeof assignLeadSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const outbox = new Outbox();
    await this.mutate(id, actor.id, 'assigned', async (tx, lead) => {
      const current = lead.assignedToId;
      const userId = input.userId;
      const takesFreeOrOwn = userId === actor.id && (current === null || current === actor.id);
      const releasesOwn = userId === null && current === actor.id;
      if (!takesFreeOrOwn && !releasesOwn && !actor.permissions.has('leads.assign')) {
        throw leadForbidden();
      }
      if (userId !== null) await this.assertAssignable(tx, userId);
      await this.applyAssignment(tx, lead, userId, actor.id, outbox);
    });
    await this.flush(outbox);
  }

  async bulkAssign(
    ids: number[],
    userId: number | null,
    actor: AuthUser,
  ): Promise<{ updated: number[]; failed: Array<{ id: number; code: string }> }> {
    if (userId !== null) await this.assertAssignable(this.prisma, userId);
    const outbox = new Outbox();
    const result = await this.bulk(ids, actor.id, 'assigned', (tx, lead) =>
      this.applyAssignment(tx, lead, userId, actor.id, outbox),
    );
    await this.flush(outbox);
    return result;
  }

  // ---------------------------------------------------------------- status

  /** Park (lost / spam / job applicant), undo (reopen) or mark contacted. */
  async changeStatus(
    id: number,
    input: z.output<typeof leadStatusChangeSchema>,
    actor: AuthUser,
  ): Promise<void> {
    const outbox = new Outbox();
    await this.mutate(id, actor.id, 'status_changed', (tx, lead) =>
      this.applyStatus(tx, lead, input, actor.id, outbox),
    );
    await this.flush(outbox);
  }

  async bulkStatus(
    input: z.output<typeof bulkLeadStatusSchema>,
    actor: AuthUser,
  ): Promise<{ updated: number[]; failed: Array<{ id: number; code: string }> }> {
    const outbox = new Outbox();
    const result = await this.bulk(input.ids, actor.id, 'status_changed', (tx, lead) =>
      this.applyStatus(tx, lead, input, actor.id, outbox),
    );
    await this.flush(outbox);
    return result;
  }

  private async applyStatus(
    tx: Tx,
    lead: Lead,
    input: { status: string; lostReason?: string | null; note?: string | null },
    by: number,
    outbox: Outbox,
  ): Promise<void> {
    const note = input.note ?? null;
    if (input.status === 'reopen') {
      if (!isParkedLeadStatus(lead.status)) throw leadTransition();
      await this.save(tx, lead.id, { lostReason: null, statusNote: null });
      await this.moveTo(tx, lead, lead.lastContactedAt ? 'contacted' : 'new', by, {
        reopened: true,
        note,
      });
      return;
    }
    if (input.status === 'contacted') {
      if (lead.status !== 'new') throw leadTransition();
      const now = this.clock.now();
      await this.save(tx, lead.id, {
        lastContactedAt: lead.lastContactedAt ?? now,
        firstResponseAt: lead.firstResponseAt ?? now,
      });
      await this.moveTo(tx, lead, 'contacted', by, { note });
      return;
    }
    const status = input.status as LeadStatus;
    if (!isOpenLeadStatus(lead.status)) throw leadTransition();
    if (status === 'lost' && !input.lostReason) {
      throw validationError({ lostReason: ['Choose why the lead was lost.'] });
    }
    const lostReason = status === 'lost' ? (input.lostReason as Lead['lostReason']) : null;
    await this.save(tx, lead.id, { lostReason, statusNote: note, nextFollowUpAt: null });
    await this.moveTo(tx, lead, status, by, { lostReason, note });
    await this.cancelScheduledTrials(tx, lead, by, outbox);
  }

  /**
   * A closed lead keeps no booked trial: its still-scheduled trial classes are cancelled so the
   * teacher's day and the board stay right. Their Zoom meetings go after the commit.
   */
  async cancelScheduledTrials(
    tx: Tx,
    lead: Lead,
    by: number | null,
    outbox: Outbox,
  ): Promise<number> {
    if (!lead.familyId) return 0;
    const sessions = await tx.classSession.findMany({
      where: {
        kind: 'trial',
        stage: 'scheduled',
        deletedAt: null,
        student: { familyId: lead.familyId },
      },
      select: { id: true, studentId: true },
      orderBy: { id: 'asc' },
    });
    for (const s of sessions) {
      await this.machine.apply(
        s.id,
        'cancel',
        Actor.system(),
        { stageReason: 'admin', note: 'lead_closed' },
        tx,
      );
      outbox.cancelledSessions.push(s.id);
      await this.log(
        tx,
        lead.id,
        'trial_cancelled',
        null,
        {
          sessionId: s.id,
          studentId: s.studentId,
          reason: 'lead_closed',
        },
        by,
      );
    }
    return sessions.length;
  }

  // ---------------------------------------------------------------- shared helpers (trial service too)

  /** Sets the status and writes the status_changed entry (no-op when unchanged). */
  async moveTo(
    tx: Tx,
    lead: Lead,
    to: LeadStatus,
    by: number | null,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    const from = lead.status;
    if (from === to) return;
    await this.save(tx, lead.id, { status: to, statusChangedAt: this.clock.now() });
    lead.status = to;
    await this.log(
      tx,
      lead.id,
      'status_changed',
      typeof meta.note === 'string' ? meta.note : null,
      compact({ from, to, ...meta }),
      by,
    );
  }

  async log(
    tx: Tx,
    leadId: number,
    type: LeadActivityType,
    body: string | null,
    meta: Record<string, unknown> | null,
    by: number | null,
    callResult: string | null = null,
  ): Promise<number> {
    const row = await tx.leadActivity.create({
      data: {
        leadId,
        type,
        body,
        callResult,
        meta: meta && Object.keys(meta).length ? (meta as Prisma.InputJsonValue) : Prisma.DbNull,
        userId: by,
        createdAt: this.clock.now(),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Writes lead fields (stamps `updated_at` from the app clock). */
  async save(tx: Tx, id: number, data: Prisma.LeadUpdateInput): Promise<void> {
    if (!Object.keys(data).length) return;
    await tx.lead.update({ where: { id }, data: { ...data, updatedAt: this.clock.now() } });
  }

  /** Re-reads the lead under a row lock (404 when missing). */
  async lockRow(tx: Tx, id: number): Promise<Lead> {
    const rows = await tx.$queryRaw<
      Array<{ id: number }>
    >`SELECT id FROM "leads" WHERE id = ${id} FOR UPDATE`;
    if (!rows.length) throw notFound();
    return tx.lead.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Runs `fn` on the locked lead inside a transaction (or the caller's), then audits the change.
   * Zoom meetings of classes cancelled inside are removed after the commit.
   */
  async mutate<T>(
    id: number,
    actorId: number | null,
    action: string,
    fn: (tx: Tx, lead: Lead) => Promise<T>,
    outbox?: Outbox,
  ): Promise<T> {
    const run = async (tx: Tx) => {
      const lead = await this.lockRow(tx, id);
      const before = snapshot(lead);
      const out = await fn(tx, lead);
      const after = snapshot(await tx.lead.findUniqueOrThrow({ where: { id } }));
      const changes = diff(before, after);
      if (changes) {
        await this.audit.record(
          {
            actorId,
            action,
            subjectType: 'lead',
            subjectId: id,
            before: changes[0],
            after: changes[1],
          },
          tx,
        );
      }
      return out;
    };
    const result = await this.prisma.$transaction(run, { timeout: 30_000 });
    if (outbox) await this.flush(outbox);
    return result;
  }

  /** Delivers the alerts and removes the Zoom meetings of cancelled classes (after commit). */
  async flush(outbox: Outbox): Promise<void> {
    if (outbox.alerts.length) await this.notifier.deliver(outbox.alerts);
    for (const sessionId of outbox.cancelledSessions) {
      try {
        await this.zoom.delete(sessionId);
      } catch (error) {
        this.logger.warn(`Zoom delete failed for class ${sessionId}: ${(error as Error).message}`);
      }
    }
    outbox.alerts.length = 0;
    outbox.cancelledSessions.length = 0;
  }

  /** Same email / phone digits on an open lead created in the last 30 days (D107). */
  async openDuplicate(tx: Tx, email: string | null, digits: string | null): Promise<Lead | null> {
    if (!email && !digits) return null;
    return tx.lead.findFirst({
      where: {
        status: { in: [...OPEN_LEAD_STATUSES] },
        createdAt: { gte: new Date(this.clock.nowMs() - DUPLICATE_WINDOW_DAYS * DAY) },
        OR: [...(email ? [{ email }] : []), ...(digits ? [{ phoneDigits: digits }] : [])],
      },
      orderBy: { id: 'asc' },
    });
  }

  /** Normalised fields (Laravel `normalise()`); `partial` keeps absent keys absent. */
  normalise(
    data: IntakeData & { parentName?: string | null },
    partial: boolean,
    academyZone: string,
  ): IntakeData & { phoneDigits?: string | null } {
    const out: IntakeData & { phoneDigits?: string | null } = {};
    const text = (v: string | null | undefined) =>
      typeof v === 'string' ? v.trim() || null : (v ?? null);
    for (const f of [
      'parentName',
      'city',
      'courseInterest',
      'preferredTimes',
      'message',
      'site',
      'preferredLanguage',
    ] as const) {
      if (data[f] !== undefined) out[f] = text(data[f]);
    }
    if (data.email !== undefined) out.email = data.email ? data.email.trim().toLowerCase() : null;
    if (data.phone !== undefined) {
      out.phone = data.phone ? data.phone.trim() : null;
      out.phoneDigits = phoneDigits(out.phone);
    }
    if (data.countryCode !== undefined) {
      out.countryCode = data.countryCode ? data.countryCode.trim().toUpperCase() : null;
    }
    if (data.timezone) out.timezone = data.timezone;
    else if (!partial) out.timezone = zoneForCountry(out.countryCode, academyZone);
    if (data.children !== undefined) out.children = (data.children ?? []).map(cleanChild);
    for (const f of [
      'source',
      'utm',
      'referralFamilyId',
      'preferredSchedule',
      'teacherGenderPref',
      'heardFrom',
      'externalRef',
    ] as const) {
      if (data[f] !== undefined) (out as Record<string, unknown>)[f] = data[f];
    }
    if (!partial) {
      out.source ??= 'web_form';
      out.children ??= [];
      out.parentName ??= '—';
    }
    return out;
  }

  private createData(data: IntakeData & { phoneDigits?: string | null }) {
    return {
      source: data.source ?? 'web_form',
      site: data.site ?? null,
      parentName: data.parentName ?? '—',
      email: data.email ?? null,
      phone: data.phone ?? null,
      phoneDigits: data.phoneDigits ?? null,
      countryCode: data.countryCode ?? null,
      city: data.city ?? null,
      timezone: data.timezone!,
      preferredLanguage: data.preferredLanguage ?? null,
      children: (data.children ?? []) as unknown as Prisma.InputJsonValue,
      courseInterest: data.courseInterest ?? null,
      preferredTimes: data.preferredTimes ?? null,
      preferredSchedule: data.preferredSchedule ? data.preferredSchedule : Prisma.DbNull,
      teacherGenderPref: data.teacherGenderPref ?? null,
      heardFrom: data.heardFrom ?? null,
      message: data.message ?? null,
      utm: data.utm ? data.utm : Prisma.DbNull,
      externalRef: data.externalRef ?? null,
      referralFamilyId: data.referralFamilyId ?? null,
    } satisfies Partial<Prisma.LeadUncheckedCreateInput>;
  }

  /** The intake reference was seen: a lead carries it, or a merged entry logged it. */
  private async seen(tx: Tx, ref: string): Promise<boolean> {
    if (await tx.lead.findUnique({ where: { externalRef: ref }, select: { id: true } }))
      return true;
    return !!(await tx.leadActivity.findFirst({
      where: { type: 'resubmitted', meta: { path: ['externalRef'], equals: ref } },
      select: { id: true },
    }));
  }

  private async applyAssignment(
    tx: Tx,
    lead: Lead,
    userId: number | null,
    by: number | null,
    outbox: Outbox,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    if (lead.assignedToId === userId) return;
    const from = lead.assignedToId;
    const assignee = userId
      ? await tx.user.findUnique({ where: { id: userId }, select: { id: true, name: true } })
      : null;
    await this.save(tx, lead.id, {
      assignedTo: userId ? { connect: { id: userId } } : { disconnect: true },
      assignedAt: userId ? this.clock.now() : null,
    });
    lead.assignedToId = userId;
    await this.log(
      tx,
      lead.id,
      'assigned',
      null,
      {
        from,
        to: userId,
        toName: assignee?.name ?? null,
        ...meta,
      },
      by,
    );
    // The new owner hears about it, unless they took the lead themselves.
    if (assignee && assignee.id !== by) {
      outbox.push({
        userId: assignee.id,
        event: 'assigned',
        leadId: lead.id,
        parentName: lead.parentName,
        assignee: assignee.name,
      });
    }
  }

  /** Only active people who work leads (`leads.manage`) can own one: 422 `userId` otherwise. */
  async assertAssignable(db: Tx | PrismaService, userId: number): Promise<void> {
    const [user] = await usersWithPermission(db, 'leads.manage', { id: userId });
    if (!user) throw validationError({ userId: ['This person cannot take leads.'] });
  }

  /** Each lead in its own transaction; per-row failures are reported (docs/15 §5.5). */
  private async bulk(
    ids: number[],
    actorId: number,
    action: string,
    fn: (tx: Tx, lead: Lead) => Promise<void>,
  ): Promise<{ updated: number[]; failed: Array<{ id: number; code: string }> }> {
    const updated: number[] = [];
    const failed: Array<{ id: number; code: string }> = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.mutate(id, actorId, action, fn);
        updated.push(id);
      } catch (error) {
        const code = codeOf(error);
        if (code === null) throw error;
        failed.push({ id, code });
      }
    }
    return { updated, failed };
  }

  /** The lead's phone as E.164 when it already is one (for the parent login). */
  static e164(phone: string | null): string | null {
    if (!phone) return null;
    const clean = phone.replace(/[\s\-().]/g, '');
    return /^\+[1-9]\d{6,14}$/.test(clean) ? clean : null;
  }
}

function cleanChild(c: object): LeadChild {
  const r = c as Record<string, unknown>;
  const out: LeadChild = {};
  if (typeof r.name === 'string' && r.name.trim()) out.name = r.name.trim();
  if (r.age !== undefined && r.age !== null && r.age !== '') out.age = Math.trunc(Number(r.age));
  if (r.gender === 'male' || r.gender === 'female') out.gender = r.gender;
  if (r.courseId !== undefined && r.courseId !== null) out.courseId = Number(r.courseId);
  return out;
}

/** Drops null / undefined values (Laravel `array_filter(..., fn ($v) => $v !== null)`). */
export function compact(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== null && v !== undefined));
}
