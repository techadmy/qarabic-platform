import { isValidZone, toUtc } from '../schedule/time.js';

/**
 * Pure conversions for the Laravel (MySQL) → NestJS (Postgres) data move (N8, docs/34 §5).
 * Every function is deterministic and has a unit test (convert.spec.ts).
 */

export type Row = Record<string, unknown>;

// ------------------------------------------------------------------ typed reads

/** A string column (`''` stays `''`); null for null/undefined. Numbers become strings. */
export function str(row: Row, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Any scalar as text (objects → JSON), for messages and keys. */
export function asText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Trimmed, `''` → null. */
export function text(row: Row, col: string): string | null {
  const v = str(row, col)?.trim();
  return v ? v : null;
}

/** An integer column (numbers, numeric strings, bigint); null otherwise. */
export function int(row: Row, col: string): number | null {
  const v = row[col];
  if (v === null || v === undefined || v === '') return null;
  const n =
    typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(asText(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** MySQL tinyint(1) / '0' / '1' / true. */
export function bool(row: Row, col: string): boolean | null {
  const v = row[col];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  return Number(v) !== 0;
}

/** A JSON column: mysql2 parses `json` columns already; `text` columns hold JSON strings. */
export function json(row: Row, col: string): unknown {
  const v = row[col];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

/** Cut to the target column length (callers report when it happened). */
export function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.length > max ? value.slice(0, max) : value;
}

// ------------------------------------------------------------------ time

const DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A Laravel datetime/timestamp column read as a string (mysql2 `dateStrings`) → UTC instant.
 * Laravel writes `now()` in the app zone (`config/app.php` `timezone`, `APP_TIMEZONE`, UTC in
 * production), so the wall time is interpreted in `appZone`. Zero dates (`0000-00-00 …`) → null.
 * Milliseconds are kept (`session_events.occurred_at` is datetime(3)).
 */
export function utc(value: unknown, appZone = 'UTC'): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = asText(value).trim();
  if (raw.startsWith('0000-00-00')) return null;
  const m = DATETIME.exec(raw);
  if (!m) return null;
  const ms = /\.(\d{1,3})/.exec(raw)?.[1]?.padEnd(3, '0') ?? '000';
  const base =
    appZone === 'UTC'
      ? Date.parse(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}Z`)
      : toUtc(m[1]!, m[2]!, appZone);
  return Number.isNaN(base) ? null : new Date(base + Number(ms));
}

/** Local wall time (`date` + `HH:MM[:SS]`) in an IANA zone → UTC instant (DST-exact). */
export function localToUtc(date: string, time: string, zone: string): Date {
  return new Date(toUtc(date, time.slice(0, 8), zone));
}

/** A MySQL DATE (`YYYY-MM-DD`) → a Prisma `@db.Date` value (UTC midnight). Invalid → null. */
export function dateOnly(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = asText(value).trim().slice(0, 10);
  const m = DATE.exec(raw);
  if (!m || raw === '0000-00-00') return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}

/**
 * The free-text dates of the legacy family form (`families.date`, `trail_date`, varchar):
 * `YYYY-MM-DD`, `YYYY/MM/DD`, or day-first `DD/MM/YYYY` / `DD-MM-YYYY` (the old admin is
 * day-first; documented assumption). Anything else → null.
 */
export function looseDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const raw = asText(value).trim();
  if (!raw) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw);
  if (m) return dateOnly(`${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
  if (m) return dateOnly(`${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`);
  return null;
}

/** `HH:MM:SS` (MySQL TIME) → `HH:MM`. */
export function hhmm(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(asText(value));
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

/** MySQL TIME used as a duration (`00:45:00`) → minutes. */
export function minutesOfTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const m = /^(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(asText(value));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function zoneOr(value: string | null | undefined, fallback: string): string {
  return value && isValidZone(value) ? value : fallback;
}

export function isZone(value: string | null | undefined): value is string {
  return !!value && isValidZone(value);
}

// ------------------------------------------------------------------ money

/**
 * Integer minor units (Laravel `*_minor` bigint) → the decimal string Postgres `numeric(12,2)`
 * stores. Exact (no float): every currency in use has 2 decimals (USD, GBP, EUR, CAD, AUD, AED,
 * PKR, EGP, SAR).
 */
export function minorToDecimal(minor: number | bigint | string | null | undefined): string | null {
  if (minor === null || minor === undefined || minor === '') return null;
  let v = BigInt(typeof minor === 'number' ? Math.trunc(minor) : minor);
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / 100n;
  const cents = (v % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${cents}`;
}

/** A decimal string (`"12.30"`, `"-0.5"`) → integer minor units, exactly. */
export function decimalToMinor(value: string | number): bigint {
  const raw = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2})\d*)?$/.exec(raw);
  if (!m) throw new Error(`Not a decimal: ${raw}`);
  const minor = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -minor : minor;
}

/**
 * A legacy `double` money column (e.g. `teachers.amount_per_hour`) → decimal string, rounded
 * half-up to 2 places through its shortest decimal text (no binary float arithmetic).
 */
export function floatToDecimal(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const [whole, frac = ''] = Math.abs(value).toString().includes('e')
    ? Math.abs(value).toFixed(6).split('.')
    : Math.abs(value).toString().split('.');
  let minor = BigInt(whole!) * 100n + BigInt(frac.slice(0, 2).padEnd(2, '0'));
  if (Number(frac[2] ?? '0') >= 5) minor += 1n;
  return minorToDecimal(value < 0 ? -minor : minor);
}

// ------------------------------------------------------------------ JSON blobs

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Laravel JSON blobs use snake_case keys and `*_minor` integer money; the Nest services read
 * camelCase keys and decimal strings (`full_amount_minor: 1234` → `fullAmount: "12.34"`).
 * Applied to app-owned blobs only (meta, payloads, rates, rules, children…), never to
 * third-party payloads (Stripe/PayPal/Zoom events, UTM tags, client context).
 */
export function camelizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeJson);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (
      k.endsWith('_minor') &&
      (typeof v === 'number' || typeof v === 'string') &&
      /^-?\d+$/.test(String(v))
    ) {
      out[camel(k.slice(0, -'_minor'.length))] = minorToDecimal(String(v));
    } else {
      out[camel(k)] = camelizeJson(v);
    }
  }
  return out;
}

// ------------------------------------------------------------------ people

/**
 * Phone → E.164 (`+447700900123`, max 15 digits). Keeps a leading `+`, turns a leading `00`
 * into `+`; a number without either has no country code and cannot be made E.164 → null
 * (reported). Spaces, dashes, dots and brackets are dropped.
 */
export function e164(value: string | null): string | null {
  if (!value) return null;
  let raw = value.trim().replace(/[\s\-().]/g, '');
  if (raw.startsWith('00')) raw = `+${raw.slice(2)}`;
  if (!/^\+\d+$/.test(raw)) return null;
  const digits = raw.slice(1).replace(/^0+/, '');
  return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
}

/** Laravel `Student::genders` (1 Male, 2 Female) or the teacher form's `Male` / `Female`. */
export function gender(value: string | null): 'male' | 'female' | null {
  const v = value?.trim().toLowerCase();
  if (v === '1' || v === 'male' || v === 'm') return 'male';
  if (v === '2' || v === 'female' || v === 'f') return 'female';
  return null;
}

/** Laravel `Student::languages` 1 English, 2 Urdu, 3 Eng-Urdu, 4 Pushto, 5 Arabic. */
export function studentLanguage(
  value: string | null,
): 'english' | 'urdu' | 'english_urdu' | 'pashto' | 'arabic' | null {
  const map = {
    '1': 'english',
    '2': 'urdu',
    '3': 'english_urdu',
    '4': 'pashto',
    '5': 'arabic',
  } as const;
  const v = value?.trim().toLowerCase() ?? '';
  if (v in map) return map[v as keyof typeof map];
  const byName: Record<string, 'english' | 'urdu' | 'english_urdu' | 'pashto' | 'arabic'> = {
    english: 'english',
    urdu: 'urdu',
    'eng-urdu': 'english_urdu',
    english_urdu: 'english_urdu',
    pushto: 'pashto',
    pashto: 'pashto',
    arabic: 'arabic',
  };
  return byName[v] ?? null;
}

export type FamilyStatus = 'regular' | 'trial' | 'on_leave' | 'suspended' | 'deactivated';

/**
 * Family status (Laravel `families.status`, free varchar; docs/06 §4, `EnrollmentService::
 * syncWithFamilyStatus`): case-insensitive; `leave` = on_leave, `suspend` = suspended,
 * `inactive` = deactivated, empty = regular. Unknown → null (the caller reports and uses regular).
 */
export function familyStatus(value: string | null): FamilyStatus | null {
  const v = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!v) return 'regular';
  const map: Record<string, FamilyStatus> = {
    regular: 'regular',
    trial: 'trial',
    on_leave: 'on_leave',
    leave: 'on_leave',
    suspended: 'suspended',
    suspend: 'suspended',
    deactivated: 'deactivated',
    inactive: 'deactivated',
  };
  return map[v] ?? null;
}

/** One of `allowed` (exact, lower-cased) or null. */
export function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  const v = value?.trim().toLowerCase();
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export const SESSION_STAGES = [
  'scheduled',
  'activated',
  'in_progress',
  'ended',
  'taken',
  'absent',
  'declined',
  'leave',
  'cancelled',
  'moved_out',
] as const;
export type Stage = (typeof SESSION_STAGES)[number];

/**
 * Class stage: the M2 `stage` column (SessionStage, identical values) wins; a row the old
 * admin wrote without one falls back to the legacy `status` the way Laravel's
 * `ClassSession::fillFromLegacy` reads it (started → in_progress, ended → ended, canceled →
 * cancelled, else scheduled).
 */
export function sessionStage(stage: string | null, legacyStatus: string | null): Stage {
  const s = oneOf(stage, SESSION_STAGES);
  if (s) return s;
  switch (legacyStatus?.trim().toLowerCase()) {
    case 'started':
      return 'in_progress';
    case 'ended':
      return 'ended';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'scheduled';
  }
}

/** Laravel model class (`App\Models\Feedback\FeedbackTicket`) → `feedback_ticket`. */
export function subjectTypeOf(cls: string | null): string {
  const base = (cls ?? 'unknown').split('\\').pop() ?? 'unknown';
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .slice(0, 64);
}
