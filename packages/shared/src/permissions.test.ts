import { describe, expect, it } from 'vitest';
import { allPermissions, MODULES, permissionsFor, ROLES } from './permissions.js';
import { cleanCredential, loginSchema } from './auth.js';

describe('role matrix (ported from Laravel RoleMatrix)', () => {
  it('gives admin every permission', () => {
    expect(permissionsFor('admin')).toEqual(allPermissions());
    expect(allPermissions()).toHaveLength(
      Object.values(MODULES).reduce((n, a) => n + a.length, 0),
    );
  });

  it('expands wildcards and only yields known permissions', () => {
    const known = new Set(allPermissions());
    for (const role of ROLES) {
      for (const p of permissionsFor(role)) expect(known.has(p)).toBe(true);
    }
    expect(permissionsFor('monitor')).toEqual(expect.arrayContaining(['schedule.view', 'schedule.manage']));
  });

  it('keeps teacher privacy (D138): no staff-wide modules', () => {
    const t = permissionsFor('teacher');
    for (const p of ['staff.view', 'families.view', 'schedule.view', 'reports.view', 'complaints.view', 'tasks.view']) {
      expect(t).not.toContain(p);
    }
    expect(t).toEqual(expect.arrayContaining(['sessions.view', 'sessions.conduct']));
  });
});

describe('login schema', () => {
  it('cleans a pasted password with invisible marks', () => {
    expect(cleanCredential(' ‏Qarabic-abc123‎\n')).toBe('Qarabic-abc123');
    const parsed = loginSchema.parse({ email: ' a@b.co ', password: '﻿pw​' });
    expect(parsed).toEqual({ email: 'a@b.co', password: 'pw', remember: true });
  });
});
