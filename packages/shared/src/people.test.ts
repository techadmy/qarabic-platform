import { describe, expect, it } from 'vitest';
import { countryList, isTimeZone } from './countries.js';
import {
  activeStatusChangeSchema,
  createFamilySchema,
  createTeacherSchema,
  familyListQuerySchema,
  familyStatusChangeSchema,
  updateFamilySchema,
} from './people.js';
import { createRoleSchema } from './roles.js';
import { updateMeSchema } from './auth.js';

describe('People field rules (Laravel PeopleRules)', () => {
  it('normalises email and phone to lower case and E.164', () => {
    const family = createFamilySchema.parse({
      parentName: ' Amina ',
      email: ' Amina.Khan@Example.com ',
      phone: '+44 (7700) 900-123',
      timezone: 'Europe/London',
      countryCode: 'gb',
    });
    expect(family).toMatchObject({
      parentName: 'Amina',
      email: 'amina.khan@example.com',
      phone: '+447700900123',
      countryCode: 'GB',
      status: 'regular',
    });
    for (const phone of ['0100', '+0123456789', '+1234']) {
      expect(createFamilySchema.safeParse({ ...family, phone }).success).toBe(false);
    }
  });

  it('clears optional fields with "" or null and refuses status on PATCH', () => {
    expect(updateFamilySchema.parse({ zoomId: '', comment: null })).toEqual({
      zoomId: null,
      comment: null,
    });
    expect(updateFamilySchema.safeParse({ status: 'suspended' }).success).toBe(false);
    expect(updateFamilySchema.safeParse({ parentName: '' }).success).toBe(false);
  });

  it('keeps money as a 2-decimal string and refuses more decimals', () => {
    const base = { firstName: 'O', email: 'o@x.co', phone: '+201001234567', timezone: 'UTC' };
    expect(createTeacherSchema.parse({ ...base, hourlyRate: 6.5 }).hourlyRate).toBe('6.50');
    expect(createTeacherSchema.parse({ ...base, hourlyRate: '120' }).hourlyRate).toBe('120.00');
    expect(createTeacherSchema.safeParse({ ...base, hourlyRate: '1.234' }).success).toBe(false);
    expect(createTeacherSchema.safeParse({ ...base, hourlyRate: -1 }).success).toBe(false);
  });

  it('needs a reason for the statuses the old system required a comment for (D123)', () => {
    expect(familyStatusChangeSchema.safeParse({ status: 'suspended' }).success).toBe(false);
    expect(familyStatusChangeSchema.safeParse({ status: 'suspended', reason: '  ' }).success).toBe(
      false,
    );
    expect(familyStatusChangeSchema.parse({ status: 'regular' })).toEqual({
      status: 'regular',
      reason: null,
    });
    expect(activeStatusChangeSchema.parse({ status: 'inactive', reason: ' Left ' })).toEqual({
      status: 'inactive',
      reason: 'Left',
    });
  });

  it('parses list query strings with defaults', () => {
    expect(familyListQuerySchema.parse({ archived: '1', page: '2' })).toMatchObject({
      archived: true,
      page: 2,
      perPage: 25,
      sort: 'id',
    });
    expect(familyListQuerySchema.safeParse({ perPage: '101' }).success).toBe(false);
  });
});

describe('reference data', () => {
  it('names every country in Arabic and English and validates IANA zones', () => {
    const egypt = countryList().find((c) => c.code === 'EG');
    expect(egypt).toEqual({ code: 'EG', nameAr: 'مصر', nameEn: 'Egypt' });
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Base')).toBe(false);
  });
});

describe('roles and me', () => {
  it('needs permissions or a role to copy', () => {
    expect(createRoleSchema.safeParse({ labelAr: 'مشرف' }).success).toBe(false);
    expect(createRoleSchema.safeParse({ labelAr: 'مشرف', permissions: [] }).success).toBe(true);
    expect(createRoleSchema.safeParse({ labelAr: 'مشرف', copyFrom: 3 }).success).toBe(true);
  });

  it('needs the current password for a new one, and at least one field', () => {
    expect(updateMeSchema.safeParse({}).success).toBe(false);
    expect(updateMeSchema.safeParse({ password: 'long-enough' }).success).toBe(false);
    expect(
      updateMeSchema.safeParse({ password: 'long-enough', currentPassword: 'x' }).success,
    ).toBe(true);
    expect(updateMeSchema.parse({ phone: '+44 7700 900123' }).phone).toBe('+447700900123');
  });
});
