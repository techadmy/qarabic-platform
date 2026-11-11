import { QURAN_SURAHS, type AyahPoint } from '@qarabic/shared';
import type { UiLocale } from '@/lib/time';

/** «البقرة» / «Al-Baqarah» (the number when it is outside 1–114). */
export function surahName(n: number, locale: UiLocale): string {
  const s = QURAN_SURAHS[n - 1];
  if (!s) return String(n);
  return locale === 'ar' ? s.nameAr : s.nameEn;
}

/**
 * A hifz range in words: «النبأ 1–16» inside one surah, «الناس 1 – الفلق 5» across surahs (any
 * direction). Numbers are Latin digits (docs/15 §5.10).
 */
export function rangeText(e: { from: AyahPoint; to: AyahPoint }, locale: UiLocale): string {
  if (e.from.surah === e.to.surah) {
    return `${surahName(e.from.surah, locale)} ${e.from.ayah}–${e.to.ayah}`;
  }
  return `${surahName(e.from.surah, locale)} ${e.from.ayah} – ${surahName(e.to.surah, locale)} ${e.to.ayah}`;
}

/** «سبق» from «الدرس الجديد (سبق)»: the term in brackets, for compact filters. */
export function shortLabel(full: string): string {
  return /\(([^)]+)\)/.exec(full)?.[1] ?? full;
}
