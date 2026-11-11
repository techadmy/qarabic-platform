import type { BoardCounter, SessionDto, SessionStage } from '@qarabic/shared';

/**
 * Today board tiles and filters (docs/15 §3.1 K1, §6.1; the current app's `boardFilters`): one
 * row of the five tiles a monitor watches, the other old statuses behind «كل الحالات», and the
 * follow-ups above zero in one attention bar. A tile filters exactly what its counter counts.
 */
export type BoardTile = BoardCounter | 'needs_action';

export const PRIMARY_TILES: BoardTile[] = [
  'total',
  'running',
  'remaining',
  'taken',
  'needs_action',
];
export const STATUS_TILES: BoardCounter[] = [
  'late',
  'absent',
  'leave',
  'declined',
  'suspended',
  'trial',
  'advance',
  'rescheduled',
  'extra',
  'holiday',
];
/** What «تحتاج إجراء» is made of, in priority order (each is also a filter). */
export const ATTENTION_TILES: BoardCounter[] = [
  'late',
  'needs_entry',
  'ended',
  'pending_requests',
  'zoom_failed',
  'teacher_unavailable',
  'needs_review',
];
export const ALL_TILES: BoardTile[] = [
  ...PRIMARY_TILES,
  ...STATUS_TILES,
  ...ATTENTION_TILES.filter((k) => !STATUS_TILES.includes(k)),
];

const has = (s: SessionDto, code: string) => s.attention.includes(code);

/** Codes that make a class need someone to act now. */
const ACTION_CODES = new Set([
  'late',
  'needs_entry',
  'report_missing',
  'teacher_unavailable',
  'zoom_failed',
  'needs_review',
  'pending_request',
]);
export const needsAttention = (s: SessionDto) => s.attention.some((a) => ACTION_CODES.has(a));

export function matchesTile(tile: BoardTile, s: SessionDto): boolean {
  switch (tile) {
    case 'needs_action':
      return needsAttention(s);
    case 'total':
      return s.stage !== 'moved_out';
    case 'remaining':
      return s.stage === 'scheduled';
    case 'running':
      return s.stage === 'activated' || s.stage === 'in_progress';
    case 'suspended':
      return (
        s.stage === 'cancelled' &&
        (s.stageReason === 'family_suspended' || s.stageReason === 'family_on_leave')
      );
    case 'holiday':
      return s.stage === 'cancelled' && s.stageReason === 'holiday';
    case 'trial':
    case 'advance':
    case 'rescheduled':
    case 'extra':
      return s.kind === tile && s.stage !== 'moved_out';
    case 'taken':
    case 'absent':
    case 'leave':
    case 'declined':
    case 'ended':
      return s.stage === tile;
    case 'pending_requests':
      return s.pendingRequests.length > 0;
    default:
      return has(s, tile);
  }
}

/** Board counters plus the client-side «تحتاج إجراء». */
export function tileCount(
  tile: BoardTile,
  counters: Partial<Record<BoardCounter, number>> | undefined,
  rows: SessionDto[],
): number {
  if (tile === 'needs_action') return rows.filter(needsAttention).length;
  return counters?.[tile] ?? 0;
}

export interface BoardFilters {
  tile: BoardTile | null;
  teacher: number | null;
  stage: SessionStage | null;
  q: string;
}

export function applyFilters(rows: SessionDto[], f: BoardFilters): SessionDto[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((s) => {
    if (f.tile && !matchesTile(f.tile, s)) return false;
    if (f.teacher && s.teacher.id !== f.teacher) return false;
    if (f.stage && s.stage !== f.stage) return false;
    if (q && !s.student.name.toLowerCase().includes(q) && !s.teacher.name.toLowerCase().includes(q))
      return false;
    return true;
  });
}

/**
 * Board order (docs/15 §6.1): late rows first (they need action now), then by start time. Returns
 * where the «الآن» divider goes (before the first row starting after now), or -1.
 */
export function orderRows(rows: SessionDto[], now: Date): { rows: SessionDto[]; nowIndex: number } {
  const late = rows.filter((s) => has(s, 'late'));
  const rest = rows
    .filter((s) => !has(s, 'late'))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
  const nowIso = now.toISOString();
  const idx = rest.findIndex((s) => s.startsAt > nowIso);
  return {
    rows: [...late, ...rest],
    nowIndex: idx === -1 ? (rest.length ? late.length + rest.length : -1) : late.length + idx,
  };
}

/** Upserts a board delta by id; rows removed by a re-sync (`deleted`) leave the list. */
export function mergeRows(previous: SessionDto[], delta: SessionDto[]): SessionDto[] {
  const byId = new Map(previous.map((s) => [s.id, s]));
  for (const s of delta) {
    if (s.attention.includes('deleted')) byId.delete(s.id);
    else byId.set(s.id, s);
  }
  return [...byId.values()];
}

/** The stage a person cares about: «متأخرة» and the family's suspension show as their own. */
export type DisplayStage = SessionStage | 'late' | 'suspended';
export function displayStage(
  s: Pick<SessionDto, 'stage' | 'stageReason' | 'attention'>,
): DisplayStage {
  if (s.stage === 'scheduled' && s.attention.includes('late')) return 'late';
  if (
    s.stage === 'cancelled' &&
    (s.stageReason === 'family_suspended' || s.stageReason === 'family_on_leave')
  ) {
    return 'suspended';
  }
  return s.stage;
}
