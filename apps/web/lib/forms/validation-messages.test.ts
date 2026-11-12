import { describe, expect, it } from 'vitest';
import { dropBlank } from './validation-messages';

describe('dropBlank', () => {
  it('leaves out only the listed keys whose value is the empty string', () => {
    expect(dropBlank({ phone: '', email: '', name: 'Ali' }, ['phone'])).toEqual({
      email: '',
      name: 'Ali',
    });
  });

  it('keeps a listed key that has a value, null or whitespace', () => {
    const values = { phone: '+201000000000', alt: null, note: ' ' };
    expect(dropBlank(values, ['phone', 'alt', 'note'])).toEqual(values);
  });

  it('no keys: the same object back, untouched', () => {
    const values = { phone: '' };
    expect(dropBlank(values, [])).toBe(values);
  });
});
