import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digits, samePhone, signWebhook } from './whatsapp.js';

describe('WhatsApp helpers', () => {
  it('signs like Meta (sha256= + hex HMAC of the raw body)', () => {
    const expected = createHmac('sha256', 'secret').update('{"a":1}').digest('hex');
    expect(signWebhook(Buffer.from('{"a":1}'), 'secret')).toBe(`sha256=${expected}`);
    expect(signWebhook('{}', 'secret')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook('{}', 'secret')).not.toBe(signWebhook('{ }', 'secret'));
  });

  it('matches stored phones to WhatsApp numbers (Laravel PhoneMatcher)', () => {
    expect(digits('+20 100 123 4567')).toBe('201001234567');
    expect(samePhone('201001234567', '+20 100 123 4567')).toBe(true);
    expect(samePhone('201001234567', '0020 100 123 4567')).toBe(true);
    expect(samePhone('201001234567', '01001234567')).toBe(true);
    expect(samePhone('201001234567', '+44 7700 900123')).toBe(false);
    expect(samePhone('201001234567', '1234')).toBe(false);
  });
});
