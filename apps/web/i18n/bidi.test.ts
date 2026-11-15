import { describe, expect, it } from 'vitest';
import ar from '@/messages/ar.json';
import en from '@/messages/en.json';
import { FSI, ISOLATED_PLACEHOLDERS, NOT_ISOLATED_KEYS, PDI, stripIsolates } from './bidi';

/** Every message string with its dotted key. */
function entries(node: unknown, path = ''): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => entries(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/**
 * docs/39 P1-10: a person's or record's own text interpolated into a sentence is isolated, so a
 * Latin name does not reorder an Arabic sentence (and the reverse). Not checked, on purpose:
 * - keys in NOT_ISOLATED_KEYS: text that leaves the app (WhatsApp prefill, mailto, CSV, clipboard);
 * - a placeholder inside a URL in the message;
 * - ICU plural/select arguments (`{count, plural, …}`): those are numbers or enum keys.
 */
function unisolated(messages: unknown): string[] {
  const out: string[] = [];
  for (const [key, text] of entries(messages)) {
    if (NOT_ISOLATED_KEYS.some((k) => key === k || key.startsWith(`${k}.`))) continue;
    if (/https?:\/\/|mailto:|wa\.me/.test(text)) continue;
    for (const name of ISOLATED_PLACEHOLDERS) {
      const token = `{${name}}`;
      let at = text.indexOf(token);
      while (at !== -1) {
        const isolated = text[at - 1] === FSI && text[at + token.length] === PDI;
        const inBdi = text.lastIndexOf('<bdi>', at) > text.lastIndexOf('</bdi>', at);
        if (!isolated && !inBdi) out.push(`${key}: ${token}`);
        at = text.indexOf(token, at + token.length);
      }
    }
  }
  return out;
}

describe('bidi isolation of interpolated values (docs/39 P1-10)', () => {
  it.each([
    ['ar', ar],
    ['en', en],
  ])('every name/number/title placeholder in %s is isolated', (_, messages) => {
    expect(unisolated(messages)).toEqual([]);
  });

  it('isolates are balanced in every message', () => {
    for (const [key, text] of [...entries(ar), ...entries(en)]) {
      const opens = text.split(FSI).length - 1;
      const closes = text.split(PDI).length - 1;
      expect(opens, key).toBe(closes);
    }
  });

  it('stripIsolates gives the plain sentence back', () => {
    expect(stripIsolates(`حذف الدور «${FSI}Admin (2)${PDI}»؟`)).toBe('حذف الدور «Admin (2)»؟');
  });
});
