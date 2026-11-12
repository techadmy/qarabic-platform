import { describe, expect, it } from 'vitest';
import { registerDeviceSchema } from './devices.js';
import { notificationPreferenceSchema } from './operations.js';

describe('mobile readiness contract (docs/17 §5)', () => {
  it('validates a device registration', () => {
    expect(registerDeviceSchema.safeParse({ token: 'x'.repeat(20), platform: 'ios' }).success).toBe(
      true,
    );
    expect(registerDeviceSchema.safeParse({ token: 'short', platform: 'ios' }).success).toBe(false);
    expect(
      registerDeviceSchema.safeParse({ token: 'x'.repeat(20), platform: 'symbian' }).success,
    ).toBe(false);
    expect(
      registerDeviceSchema.safeParse({ token: `${'x'.repeat(20)} y`, platform: 'ios' }).success,
    ).toBe(false);
  });

  it('push preference defaults to on for older clients', () => {
    expect(
      notificationPreferenceSchema.parse({
        kind: 'task',
        inApp: true,
        email: false,
        whatsapp: false,
      }).push,
    ).toBe(true);
  });
});
