import { Injectable } from '@nestjs/common';
import {
  type HifzEntryDto,
  hifzAyahs,
  type LessonReportDto,
  type lessonReportInputSchema,
  type Paginated,
  REPORT_STATES,
  type ReportListItemDto,
  type reportListQuerySchema,
  type ReportState,
} from '@qarabic/shared';
import type { z } from 'zod';
import { AuditService, diff } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { Clock } from '../common/clock.js';
import { pageArgs, pageMeta } from '../common/pagination.js';
import type { HifzEntry, LessonReport, Prisma } from '../generated/prisma/client.js';
import { isParentViewer, type Tx } from '../people/people.common.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { forbidden, sessionScopeWhere, viewerScope } from '../schedule/scope.js';
import { HOUR, isoZ } from '../schedule/time.js';
import { SettingsService, type SettingsMap } from '../settings/settings.service.js';
import { forbiddenAction, invalidTransition, outsideWindow } from './errors.js';
import { recordEvent } from './events.js';
import { SessionPresenter, sessionInclude } from './presenter.js';
import { Actor, reportEditableUntil, SessionStateMachine } from './state-machine.js';

type ReportInput = z.output<typeof lessonReportInputSchema>;
type ListQuery = z.output<typeof reportListQuerySchema>;

/** Relations a report payload needs. */
export const reportInclude = {
  hifz: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
  submittedBy: { select: { id: true, name: true } },
  updatedBy: { select: { id: true, name: true } },
} satisfies Prisma.LessonReportInclude;

export type ReportRow = Prisma.LessonReportGetPayload<{ include: typeof reportInclude }>;

export function hifzDto(h: HifzEntry): HifzEntryDto {
  return {
    type: h.type,
    from: { surah: h.fromSurah, ayah: h.fromAyah },
    to: { surah: h.toSurah, ayah: h.toAyah },
    ayahs: h.ayahs,
    pages: h.pages === null ? null : Number(h.pages),
    grade: h.grade,
    mistakes: h.mistakes,
    notes: h.notes,
  };
}

/** Parents see the 1–5 rating unless the B30 setting is off. */
export const ratingVisible = (viewer: AuthUser, st: SettingsMap) =>
  !isParentViewer(viewer) || st['reports.parent_sees_rating'];

/**
 * The report payload (Laravel `LessonReportResource`) for a viewer: parents never get the internal
 * note, the authors or the edit deadline, and the rating only when B30 allows it.
 */
export function reportDto(
  r: ReportRow,
  session: { stage: string; markedAt: Date | null },
  viewer: AuthUser,
  st: SettingsMap,
): LessonReportDto {
  const parent = isParentViewer(viewer);
  return {
    id: r.id,
    sessionId: r.sessionId,
    studentId: r.studentId,
    teacherId: r.teacherId,
    summary: r.summary,
    homework: r.homework,
    tajweedNotes: r.tajweedNotes,
    ...(parent ? {} : { teacherNotes: r.teacherNotes }),
    ...(ratingVisible(viewer, st) ? { rating: r.rating } : {}),
    hifz: r.hifz.map(hifzDto),
    dueAt: isoZ(r.dueAt)!,
    late: r.submittedLate,
    submittedAt: isoZ(r.submittedAt)!,
    updatedAt: isoZ(r.updatedAt)!,
    ...(parent
      ? {}
      : {
          submittedBy: r.submittedBy,
          updatedBy: r.updatedBy,
          editableUntil: isoZ(
            reportEditableUntil(
              { stage: session.stage as 'taken', markedAt: session.markedAt, report: r },
              st,
            ),
          ),
        }),
  };
}

/** Audited fields of a report (before / after an edit). */
function snapshot(r: LessonReport & { hifz: HifzEntry[] }): Record<string, unknown> {
  return {
    summary: r.summary,
    homework: r.homework,
    tajweedNotes: r.tajweedNotes,
    teacherNotes: r.teacherNotes,
    rating: r.rating,
    hifz: r.hifz.map(hifzDto),
  };
}

/**
 * Lesson reports (D45, D70; Laravel `LessonReportService`): `PUT /sessions/:id/report` writes the
 * report — on an `ended` class through the state machine (`submit_report` → `taken`), on a
 * `taken` class as an edit (the class's teacher inside `sessions.report_edit_hours`, staff with
 * `sessions.manage` at any time). Hifz rows are rewritten when `hifz` is sent. Plus the staff list
 * of classes by report state.
 */
@Injectable()
export class LessonReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly machine: SessionStateMachine,
    private readonly presenter: SessionPresenter,
    private readonly audit: AuditService,
  ) {}

  /** The caller has already applied the row scope (404). */
  async submit(sessionId: number, input: ReportInput, viewer: AuthUser): Promise<void> {
    const actor = await Actor.of(this.prisma, viewer);
    const st = await this.settings.all();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "class_sessions" WHERE id = ${sessionId} FOR UPDATE`;
      const s = await tx.classSession.findUniqueOrThrow({
        where: { id: sessionId },
        include: { report: { include: { hifz: true } } },
      });
      const now = this.clock.nowMs();

      if (s.stage === 'ended') {
        const { from, to } = await this.machine.apply(
          sessionId,
          'submit_report',
          actor,
          { expectedStage: input.expectedStage },
          tx,
        );
        await this.write(tx, s, input, viewer, st);
        // A concurrent submit won the race: this one is an edit.
        if (from === to) await this.edited(tx, s, viewer, now);
        return;
      }
      if (s.stage === 'taken') {
        if (!actor.canConduct(s)) throw forbiddenAction();
        const until = reportEditableUntil(s, st);
        if (!actor.canManage() && until && now > until.getTime()) {
          throw outsideWindow({ availableUntil: [isoZ(until)!] });
        }
        await this.write(tx, s, input, viewer, st);
        await this.edited(tx, s, viewer, now);
        return;
      }
      throw invalidTransition();
    });
  }

  /** `report_updated` on the timeline; the class's `updatedAt` moves so board deltas pick it up. */
  private async edited(tx: Tx, s: { id: number }, viewer: AuthUser, now: number): Promise<void> {
    await recordEvent(tx, this.clock, s.id, 'report_updated', { actor: viewer });
    await tx.classSession.update({ where: { id: s.id }, data: { updatedAt: new Date(now) } });
  }

  private async write(
    tx: Tx,
    s: {
      id: number;
      studentId: number;
      teacherId: number;
      startsAt: Date;
      endsAt: Date;
      endedAt: Date | null;
      report: (LessonReport & { hifz: HifzEntry[] }) | null;
    },
    input: ReportInput,
    viewer: AuthUser,
    st: SettingsMap,
  ): Promise<void> {
    const now = this.clock.now();
    const fields = {
      studentId: s.studentId,
      teacherId: s.teacherId,
      summary: input.summary,
      homework: input.homework ?? null,
      tajweedNotes: input.tajweedNotes ?? null,
      teacherNotes: input.teacherNotes ?? null,
      rating: input.rating ?? null,
    };
    const before = s.report;
    let reportId: number;
    if (before) {
      reportId = before.id;
      await tx.lessonReport.update({
        where: { id: before.id },
        data: { ...fields, updatedAt: now, updatedById: viewer.id },
      });
    } else {
      const dueAt = new Date(
        (s.endedAt ?? s.endsAt).getTime() + st['sessions.report_due_hours'] * HOUR,
      );
      reportId = (
        await tx.lessonReport.create({
          data: {
            ...fields,
            sessionId: s.id,
            dueAt,
            submittedLate: now.getTime() > dueAt.getTime(),
            submittedAt: now,
            submittedById: viewer.id,
            createdAt: now,
            updatedAt: now,
          },
        })
      ).id;
    }
    if (input.hifz !== undefined) {
      await tx.hifzEntry.deleteMany({ where: { reportId } });
      if (input.hifz.length) {
        await tx.hifzEntry.createMany({
          data: input.hifz.map((e, position) => ({
            reportId,
            sessionId: s.id,
            studentId: s.studentId,
            position,
            type: e.type,
            fromSurah: e.from.surah,
            fromAyah: e.from.ayah,
            toSurah: e.to.surah,
            toAyah: e.to.ayah,
            ayahs: hifzAyahs(e),
            pages: e.pages ?? null,
            grade: e.grade ?? null,
            mistakes: e.mistakes ?? null,
            notes: e.notes ?? null,
            lessonAt: s.startsAt,
            createdAt: now,
          })),
        });
      }
    }
    if (before) {
      const after = await tx.lessonReport.findUniqueOrThrow({
        where: { id: reportId },
        include: { hifz: { orderBy: { position: 'asc' } } },
      });
      const changed = diff(snapshot(before), snapshot(after));
      if (changed) {
        await this.audit.record(
          {
            actorId: viewer.id,
            action: 'updated',
            subjectType: 'lesson_report',
            subjectId: reportId,
            before: changed[0],
            after: changed[1],
          },
          tx,
        );
      }
    }
  }

  /** The report of a class the viewer may see (null when none). */
  async forSession(
    session: { id: number; stage: string; markedAt: Date | null },
    viewer: AuthUser,
  ): Promise<LessonReportDto | null> {
    const r = await this.prisma.lessonReport.findUnique({
      where: { sessionId: session.id },
      include: reportInclude,
    });
    return r ? reportDto(r, session, viewer, await this.settings.all()) : null;
  }

  // ------------------------------------------------------------------ staff list

  /**
   * `GET /lesson-reports`: ended and taken classes with where their report stands (staff all, a
   * teacher their own classes; parents 403). `state=missing` = the board's «بلا تقرير».
   */
  async list(q: ListQuery, viewer: AuthUser): Promise<Paginated<ReportListItemDto>> {
    if (isParentViewer(viewer)) throw forbidden();
    const st = await this.settings.all();
    const now = this.clock.nowMs();
    const dueMs = st['sessions.report_due_hours'] * HOUR;
    const cutoff = new Date(now - dueMs);
    const scope = await viewerScope(this.prisma, viewer);

    const and: Prisma.ClassSessionWhereInput[] = [
      sessionScopeWhere(scope),
      { deletedAt: null, stage: { in: ['ended', 'taken'] } },
    ];
    if (q.from) and.push({ startsAt: { gte: new Date(q.from) } });
    if (q.to) and.push({ startsAt: { lt: new Date(q.to) } });
    if (q.teacherId) and.push({ teacherId: q.teacherId });
    if (q.studentId) and.push({ studentId: q.studentId });

    const byState: Record<ReportState, Prisma.ClassSessionWhereInput> = {
      pending: {
        report: { is: null },
        OR: [{ endedAt: { gt: cutoff } }, { endedAt: null, endsAt: { gt: cutoff } }],
      },
      missing: {
        report: { is: null },
        OR: [{ endedAt: { lte: cutoff } }, { endedAt: null, endsAt: { lte: cutoff } }],
      },
      on_time: { report: { is: { submittedLate: false } } },
      late: { report: { is: { submittedLate: true } } },
    };
    const states = q.state?.length ? q.state : null;
    const where: Prisma.ClassSessionWhereInput = {
      AND: [...and, ...(states ? [{ OR: states.map((k) => byState[k]) }] : [])],
    };

    const include = {
      ...sessionInclude,
      report: {
        select: {
          id: true,
          submittedAt: true,
          rating: true,
          submittedLate: true,
          dueAt: true,
          submittedBy: { select: { id: true, name: true } },
        },
      },
    } satisfies Prisma.ClassSessionInclude;
    const [rows, total, ...counts] = await Promise.all([
      this.prisma.classSession.findMany({
        where,
        include,
        orderBy: [{ startsAt: 'desc' }, { id: 'desc' }],
        ...pageArgs(q),
      }),
      this.prisma.classSession.count({ where }),
      ...REPORT_STATES.map((k) =>
        this.prisma.classSession.count({ where: { AND: [...and, byState[k]] } }),
      ),
    ]);
    const sessions = await this.presenter.many(rows, viewer);
    const countMap: Record<string, number> = { all: 0 };
    REPORT_STATES.forEach((k, i) => {
      countMap[k] = counts[i]!;
      countMap.all! += counts[i]!;
    });
    return {
      data: rows.map((row, i) => {
        const r = row.report;
        const due = r ? r.dueAt.getTime() : (row.endedAt ?? row.endsAt).getTime() + dueMs;
        const state: ReportState = r
          ? r.submittedLate
            ? 'late'
            : 'on_time'
          : now > due
            ? 'missing'
            : 'pending';
        return {
          state,
          dueAt: isoZ(due)!,
          session: sessions[i]!,
          report: r
            ? {
                id: r.id,
                submittedAt: isoZ(r.submittedAt)!,
                submittedBy: r.submittedBy,
                rating: r.rating,
                late: r.submittedLate,
              }
            : null,
        };
      }),
      meta: pageMeta(q, total, countMap),
    };
  }
}
