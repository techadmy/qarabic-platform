import { describe, expect, it } from 'vitest';
import { cleanContext } from './context.js';

describe('cleanContext (Laravel ContextSanitizer)', () => {
  it('keeps known keys, strips secrets and form values, caps strings', () => {
    const out = cleanContext({
      page_url: '/monitor/today?tab=late&token=secret123&email=a@b.c',
      area: 'sessions',
      appVersion: 'abc1234',
      user_agent: 'Mozilla/5.0',
      timeZone: 'Africa/Cairo',
      password: 'never-stored',
      route: 'x'.repeat(500),
      online: 'true',
      recent_errors: [
        {
          method: 'get',
          path: '/api/v1/sessions/board?date=2026-11-09',
          status: 500,
          request_id: 'req-1',
        },
        'not an object',
      ],
    });
    expect(out.pageUrl).toBe('/monitor/today?tab=late');
    expect(out).not.toHaveProperty('password');
    expect(out.area).toBe('sessions');
    expect(out.userAgent).toBe('Mozilla/5.0');
    expect((out.route as string).length).toBe(120);
    expect(out.online).toBe(true);
    expect(out.recentErrors).toEqual([
      { method: 'GET', path: '/api/v1/sessions/board', status: 500, requestId: 'req-1' },
    ]);
  });

  it('answers an empty object for anything that is not an object', () => {
    expect(cleanContext(null)).toEqual({});
    expect(cleanContext('x')).toEqual({});
    expect(cleanContext([1, 2])).toEqual({});
  });

  it('drops the origin of an absolute page URL', () => {
    expect(cleanContext({ pageUrl: 'https://evil.example/a?code=1&b=2' }).pageUrl).toBe('/a?b=2');
  });
});
