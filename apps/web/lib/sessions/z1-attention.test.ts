import type { SessionDto } from '@qarabic/shared';
import { describe, expect, it } from 'vitest';
import { ATTENTION_TILES, matchesTile, needsAttention } from './board';

const withAttention = (code: string) =>
  ({
    stage: 'scheduled',
    kind: 'regular',
    attention: [code],
    pendingRequests: [],
  }) as unknown as SessionDto;

describe('Z1 attendance codes (#120)', () => {
  it('no-shows and short classes need action and filter as attention tiles', () => {
    for (const code of ['teacher_no_show', 'student_no_show', 'short_class'] as const) {
      expect(ATTENTION_TILES).toContain(code);
      expect(needsAttention(withAttention(code))).toBe(true);
      expect(matchesTile(code, withAttention(code))).toBe(true);
    }
  });
});
