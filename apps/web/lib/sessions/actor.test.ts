import { describe, expect, it } from 'vitest';
import { actorLabel } from './actor';

const words = { system: 'النظام', staff: 'إدارة الأكاديمية' };

describe('actorLabel (P0-4, B118)', () => {
  it('the system when there is no actor', () => {
    expect(actorLabel(null, 'ar', words)).toBe('النظام');
  });
  it('the name when the viewer may see it', () => {
    expect(actorLabel({ id: 4, name: 'Mona', role: 'monitor' }, 'ar', words)).toBe('Mona');
  });
  it('the role only when the name is withheld', () => {
    expect(actorLabel({ id: null, name: null, role: 'monitor' }, 'ar', words)).toBe('مشرف متابعة');
    expect(actorLabel({ id: null, name: null, role: 'csr' }, 'en', words)).toBe('Customer service');
  });
  it('«academy staff» for a custom role or none', () => {
    expect(actorLabel({ id: null, name: null, role: 'qa_lead' }, 'ar', words)).toBe(
      'إدارة الأكاديمية',
    );
    expect(actorLabel({ id: null, name: null, role: null }, 'ar', words)).toBe('إدارة الأكاديمية');
  });
});
