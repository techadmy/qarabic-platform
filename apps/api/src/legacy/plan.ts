import type { FieldCipher } from '../common/crypto.js';
import { asText, type Row } from './convert.js';
import type { LaravelCipher } from './laravel-crypt.js';

/** Prisma model delegate names the importer writes (camelCase, as on the client). */
export type ModelName =
  | 'permission'
  | 'role'
  | 'rolePermission'
  | 'user'
  | 'course'
  | 'teacher'
  | 'teacherCourse'
  | 'family'
  | 'student'
  | 'auditLog'
  | 'appSetting'
  | 'holiday'
  | 'zoomHost'
  | 'teacherWorkHour'
  | 'teacherBlock'
  | 'payRuleSet'
  | 'enrollment'
  | 'scheduleSlot'
  | 'classSession'
  | 'sessionEvent'
  | 'sessionRequest'
  | 'lessonReport'
  | 'hifzEntry'
  | 'studentTest'
  | 'ticket'
  | 'ticketComment'
  | 'ticketAttachment'
  | 'whatsAppInboundMessage'
  | 'lead'
  | 'leadActivity'
  | 'notification'
  | 'feePackage'
  | 'feePackagePrice'
  | 'familyBillingProfile'
  | 'studentFeePackage'
  | 'invoice'
  | 'invoiceLine'
  | 'invoiceSequence'
  | 'payment'
  | 'paymentWebhookEvent'
  | 'billingEvent'
  | 'payProfile'
  | 'leaveRequest'
  | 'staffAttendance'
  | 'payrollRun'
  | 'payslip'
  | 'payAdjustment'
  | 'payslipLine'
  | 'payslipSession'
  | 'walletTransaction'
  | 'payrollEvent';

/** A self-reference written after every row exists (`UPDATE … SET col = ref`). */
export interface SelfRef {
  column: string;
  pairs: Array<[id: number, ref: number]>;
}

/** The rows for one Postgres table. */
export interface TargetBatch {
  /** Postgres table. */
  table: string;
  model: ModelName;
  /** The Laravel table(s) read (for the counts table). */
  source: string;
  sourceCount: number;
  rows: Row[];
  /** Has a serial `id` whose sequence is reset after the load. */
  serial: boolean;
  selfRefs?: SelfRef[];
}

export type IssueKind = 'skipped' | 'changed' | 'dropped_column' | 'no_counterpart' | 'warning';

export interface Issue {
  kind: IssueKind;
  table: string;
  id: string | null;
  reason: string;
}

/** Unmappable rows and every lossy change: written to the report, never silent. */
export class ImportReport {
  readonly issues: Issue[] = [];

  skip(table: string, id: unknown, reason: string): void {
    this.issues.push({
      kind: 'skipped',
      table,
      id: id === null || id === undefined ? null : asText(id),
      reason,
    });
  }

  change(table: string, id: unknown, reason: string): void {
    this.issues.push({
      kind: 'changed',
      table,
      id: id === null || id === undefined ? null : asText(id),
      reason,
    });
  }

  warn(table: string, reason: string): void {
    this.issues.push({ kind: 'warning', table, id: null, reason });
  }

  droppedColumn(table: string, column: string, nonEmpty: number): void {
    this.issues.push({
      kind: 'dropped_column',
      table,
      id: null,
      reason: `${column}: ${nonEmpty} non-empty value(s) not carried`,
    });
  }

  noCounterpart(table: string, rows: number, why: string): void {
    this.issues.push({ kind: 'no_counterpart', table, id: null, reason: `${rows} row(s): ${why}` });
  }

  skippedIn(table: string): number {
    return this.issues.filter((i) => i.kind === 'skipped' && i.table === table).length;
  }
}

export interface ImportOptions {
  /** Laravel `APP_TIMEZONE` (config/app.php `timezone`): the zone of every stored datetime. */
  appTimezone: string;
  /** Laravel `academy.timezone` (app_settings, else `settings.timezone`, else Africa/Cairo). */
  academyTimezone: string;
  reportDueHours: number;
  /** Reads Laravel `encrypted` casts (LEGACY_APP_KEY); null = those values cannot be moved. */
  legacyCipher: LaravelCipher | null;
  /** The new app's AES-256-GCM cipher (APP_ENCRYPTION_KEY). */
  targetCipher: FieldCipher;
  /** Payroll default currency for payslips without one. */
  payrollCurrency: string;
  /** Fills `created_at`/`updated_at` that Laravel left null (fixed per run so reruns are equal). */
  fallbackNow: Date;
}

/** Everything a mapper needs. `ids` = the target ids planned so far (FK existence checks). */
export class MapContext {
  readonly ids = new Map<string, Set<number>>();
  /** Extra per-table lookups shared between mappers (e.g. class start per session id). */
  readonly lookups = new Map<string, Map<number, unknown>>();

  constructor(
    readonly src: Map<string, Row[]>,
    readonly report: ImportReport,
    readonly opts: ImportOptions,
  ) {}

  rows(table: string): Row[] {
    return this.src.get(table) ?? [];
  }

  has(table: string, id: number | null): boolean {
    return id !== null && (this.ids.get(table)?.has(id) ?? false);
  }

  /** The id if the target row exists, else null (+ a `changed` issue when it was set). */
  ref(
    table: string,
    id: number | null,
    from: string,
    rowId: unknown,
    column: string,
  ): number | null {
    if (id === null) return null;
    if (this.has(table, id)) return id;
    this.report.change(from, rowId, `${column}=${id} has no ${table} row: set to null`);
    return null;
  }

  remember(table: string, ids: Iterable<number>): void {
    const set = this.ids.get(table) ?? new Set<number>();
    for (const id of ids) set.add(id);
    this.ids.set(table, set);
  }

  /** Non-empty values of columns the new schema has no place for (reported per column). */
  dropped(table: string, columns: string[], rows: Row[] = this.rows(table)): void {
    for (const c of columns) {
      const n = rows.filter((r) => {
        const v = r[c];
        return v !== null && v !== undefined && v !== '' && v !== 0 && v !== '0';
      }).length;
      if (n > 0) this.report.droppedColumn(table, c, n);
    }
  }
}

export interface ModuleMapper {
  name: string;
  /** Laravel tables it reads. */
  sources: string[];
  /** Modules whose rows its tables reference (an --only reload pulls in the dependents). */
  dependsOn: string[];
  /** Postgres tables it owns, in load order (truncated before the load). */
  tables: string[];
  /** Extra Postgres tables with no Laravel counterpart that a reload clears (logins, …). */
  clears?: string[];
  map(ctx: MapContext): TargetBatch[];
}

export function batch(
  table: string,
  model: ModelName,
  source: string,
  sourceCount: number,
  rows: Row[],
  serial = true,
  selfRefs?: SelfRef[],
): TargetBatch {
  return { table, model, source, sourceCount, rows, serial, ...(selfRefs ? { selfRefs } : {}) };
}
