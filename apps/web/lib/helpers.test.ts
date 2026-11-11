import { describe, expect, it } from 'vitest';
import { joinE164, splitE164 } from './phone';
import { canGrant, changedCount, groupCatalog, toggleModule } from './roles/matrix';
import { cityOf, dayShift, formatDate, zoneLabel } from './time';
import { MOCK_CATALOG } from '@/mocks/data';

describe('phone (E.164)', () => {
  it('joins the dial code and the national number, dropping a leading 0 and spaces', () => {
    expect(joinE164('GB', '07700 900-123')).toBe('+447700900123');
    expect(joinE164('EG', '010 0000 0999')).toBe('+201000000999');
    expect(joinE164(null, '+1 555 010 0001')).toBe('+15550100001');
    expect(joinE164('GB', '')).toBe('');
  });

  it('splits a stored number back, preferring the record country for shared codes', () => {
    expect(splitE164('+447700900123')).toEqual({ country: 'GB', national: '7700900123' });
    expect(splitE164('+15550100001')).toEqual({ country: 'US', national: '5550100001' });
    expect(splitE164('+15550100001', 'CA')).toEqual({ country: 'CA', national: '5550100001' });
    expect(splitE164('+971555011001')).toEqual({ country: 'AE', national: '555011001' });
  });
});

describe('time (D30)', () => {
  it('names cities in Arabic and shows offsets left-to-right', () => {
    expect(cityOf('Europe/London', 'ar')).toBe('لندن');
    expect(cityOf('America/Sao_Paulo', 'ar')).toBe('Sao Paulo');
    expect(zoneLabel('UTC', 'en')).toContain('GMT');
    expect(formatDate('2026-11-09', 'ar')).toBe('9 نوفمبر 2026');
  });

  it('flags the other party being a day ahead or behind', () => {
    const at = new Date('2026-11-10T23:30:00Z');
    expect(dayShift('Africa/Cairo', 'Australia/Sydney', at)).toBe(0);
    expect(dayShift('America/New_York', 'Australia/Sydney', at)).toBe(1);
    expect(dayShift('Australia/Sydney', 'America/New_York', at)).toBe(-1);
  });
});

describe('permission matrix helpers', () => {
  const me = { permissions: ['families.view', 'roles.manage'], role: null };
  it('groups the catalog like the sidebar', () => {
    expect(groupCatalog(MOCK_CATALOG).map((g) => g.group)).toEqual([
      'people',
      'classes',
      'finance',
      'communication',
      'reports',
      'settings',
    ]);
  });

  it('never lets a non-owner grant what they lack', () => {
    expect(canGrant(me, { permissionsEditable: true }, 'families.view')).toBe(true);
    expect(canGrant(me, { permissionsEditable: true }, 'families.manage')).toBe(false);
    expect(canGrant(me, { permissionsEditable: false }, 'families.view')).toBe(false);
    const owner = {
      permissions: [],
      role: { name: 'admin', labelAr: '', labelEn: null, kind: 'owner' as const },
    };
    expect(canGrant(owner, { permissionsEditable: true }, 'payroll.approve')).toBe(true);
  });

  it('toggles a module without touching cells the viewer cannot grant, and counts changes', () => {
    const next = toggleModule(
      [],
      ['families.view', 'families.manage'],
      true,
      (p) => p === 'families.view',
    );
    expect(next).toEqual(['families.view']);
    expect(changedCount(['a', 'b'], ['b', 'c'])).toBe(2);
  });
});
