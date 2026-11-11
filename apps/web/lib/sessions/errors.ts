'use client';

import { conflictResultSchema, type ConflictResultDto } from '@qarabic/shared';
import { useLocale, useTranslations } from 'next-intl';
import { isApiError } from '@/lib/api/client';
import { clock } from '@/lib/schedule-time';
import { useCurrentUser } from '@/components/shell/app-shell';
import { browserTimeZone, isValidTimeZone } from '@/lib/time';

const KNOWN = new Set([
  'invalid_transition',
  'stale_session',
  'forbidden',
  'zoom_unavailable',
  'conflict',
  'schedule_conflict',
  'warnings_not_acknowledged',
  'same_status',
  'not_found',
]);

/**
 * The N2 refusal codes (apps/api/README.md) in the UI language: `outside_window` says when the
 * action opens, a leave without enough notice says so, the rest map to one sentence each.
 */
export function useClassError() {
  const t = useTranslations('classes.refusals');
  const locale = useLocale() === 'en' ? 'en' : 'ar';
  const me = useCurrentUser();
  const tz = isValidTimeZone(me.timezone) ? me.timezone : browserTimeZone();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('generic');
    const code = error.code ?? '';
    const errors = error.error?.errors ?? {};
    if (code === 'outside_window') {
      if (errors.notifiedAt) return t('leaveNotice');
      const from = errors.availableFrom?.[0];
      if (from && Date.parse(from) > Date.now())
        return t('opensAt', { time: clock(from, tz, locale) });
      return t('outside_window');
    }
    if (code === 'invalid_transition' && errors.teacher) return t('teacherBusy');
    if (code === 'validation_failed') {
      if (errors.courseId) return t('courseTaken');
      if (errors.meetingMode) return t('zoomOff');
      return t('validation_failed');
    }
    if (isApiError(error, 404)) return t('not_found');
    if (isApiError(error, 403)) return t('forbidden');
    if (KNOWN.has(code)) return t(code);
    return t('generic');
  };
}

/** The conflict lists of a 409 `schedule_conflict` / 422 `warnings_not_acknowledged`, or null. */
export function conflictsOf(error: unknown): ConflictResultDto | null {
  if (!isApiError(error)) return null;
  if (error.code !== 'schedule_conflict' && error.code !== 'warnings_not_acknowledged') return null;
  const data = error.error?.data ?? {};
  const parsed = conflictResultSchema.safeParse({
    conflicts: data.conflicts ?? [],
    warnings: data.warnings ?? [],
  });
  return parsed.success ? parsed.data : null;
}
