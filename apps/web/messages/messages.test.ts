import { describe, expect, it } from 'vitest';
import ar from './ar.json';
import en from './en.json';

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function values(obj: object): string[] {
  return Object.values(obj).flatMap((v) => (v && typeof v === 'object' ? values(v) : [String(v)]));
}

/** Colloquial words that must not appear in the product UI (docs/15 §9, D67). */
const COLLOQUIAL = [
  'دلوقتي',
  'الجاية',
  'ميعاد',
  'السيشن',
  'الكورس',
  'المدرس',
  'عايز',
  'عاوز',
  'ازاي',
  'إزاي',
  'كده',
  'بتاع',
  'المرتب',
  'الشغل',
  'توليد',
  'مش',
  'فين',
  'ليه',
  'خلاص',
  'دي',
  'ده',
];

describe('messages', () => {
  it('has the same keys in Arabic and English', () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });

  it('uses Modern Standard Arabic only', () => {
    const words = new Set(values(ar).flatMap((text) => text.split(/[\s.,،؟?!:«»()]+/)));
    for (const word of COLLOQUIAL) expect(words).not.toContain(word);
  });
});
