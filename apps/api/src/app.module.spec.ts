import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT } from './app.module.js';

describe('log redaction', () => {
  it('never writes cookies, auth headers, CSRF tokens or passwords', () => {
    let out = '';
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT, censor: '[redacted]' } }, stream);
    log.info({
      req: {
        headers: { cookie: 'qarabic_session=abc', authorization: 'Bearer x', 'x-xsrf-token': 't' },
      },
      res: { headers: { 'set-cookie': ['qarabic_session=abc'] } },
      body: { password: 'hunter2', token: 'reset-token' },
    });
    for (const secret of ['qarabic_session=abc', 'Bearer x', '"t"', 'hunter2', 'reset-token']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
});
