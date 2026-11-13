import { describe, expect, it } from 'vitest';
import {
  REQUEST_PAYLOAD_SCHEMAS,
  requestActionSchema,
  supportRequestSchema,
} from './support-requests.js';
import { createTicketSchema, ticketSchema } from './tickets.js';

describe('S3 typed request schemas', () => {
  it('a pause needs its end; a stop defaults to the whole family', () => {
    const pause = REQUEST_PAYLOAD_SCHEMAS.subscription_change;
    expect(pause.safeParse({ action: 'pause', from: '2026-12-01', reason: 'travel' }).success).toBe(
      false,
    );
    expect(pause.parse({ action: 'stop', from: '2026-12-01', reason: 'other' }).studentIds).toEqual(
      [],
    );
    expect(
      REQUEST_PAYLOAD_SCHEMAS.schedule_change.safeParse({
        studentId: 1,
        slots: [{ weekday: 8, localTime: '17:00' }],
        startsOn: '2026-12-01',
      }).success,
    ).toBe(false);
  });

  it('a step: propose needs a teacher, reject needs a note', () => {
    expect(requestActionSchema.safeParse({ action: 'propose' }).success).toBe(false);
    expect(requestActionSchema.safeParse({ action: 'reject', note: ' ' }).success).toBe(false);
    expect(requestActionSchema.safeParse({ action: 'approve' }).success).toBe(true);
  });

  it('the request travels as JSON in a form field; old tickets parse with request null', () => {
    const body = createTicketSchema.parse({
      description: 'Please move the classes',
      request: '{"studentId":1}',
    });
    expect(body.request).toEqual({ studentId: 1 });
    expect(ticketSchema.shape.request.parse(undefined)).toBeNull();
    expect(supportRequestSchema.safeParse({ kind: 'x' }).success).toBe(false);
  });
});
