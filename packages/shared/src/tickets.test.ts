import { describe, expect, it } from 'vitest';
import {
  CLOSED_TICKET_STATUSES,
  confirmTicketSchema,
  createTicketSchema,
  inboxQuerySchema,
  isSubcategoryOf,
  PARENT_CONTACT_CARDS,
  SUPPORT_SETTING_RULES,
  TEACHER_CONTACT_CARDS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_SUBCATEGORIES,
  TICKET_SUBCATEGORY_LABELS,
  TICKET_TRANSITIONS,
  ticketListQuerySchema,
  updateSupportSettingsSchema,
  updateTicketSchema,
} from './index.js';

describe('ticket contracts', () => {
  it('accepts multipart text fields (ids and context as strings)', () => {
    const parsed = createTicketSchema.parse({
      category: 'classes',
      subcategory: 'session_issue',
      subjectType: 'session',
      subjectId: '12',
      description: 'The teacher did not join this class',
      context: '{"area":"sessions"}',
      type: '',
    });
    expect(parsed).toMatchObject({ subjectId: 12, context: { area: 'sessions' } });
    expect(parsed.type).toBeUndefined();
    expect(createTicketSchema.safeParse({ description: 'short' }).success).toBe(false);
    expect(
      createTicketSchema.safeParse({ description: 'long enough text', channel: 'in_app' }).success,
    ).toBe(false);
  });

  it('keeps the lifecycle closed: every target is a status, closed ones only reopen', () => {
    for (const s of TICKET_STATUSES) {
      for (const to of TICKET_TRANSITIONS[s]) expect(TICKET_STATUSES).toContain(to);
    }
    for (const s of CLOSED_TICKET_STATUSES) expect(TICKET_TRANSITIONS[s]).toEqual(['triaged']);
  });

  it('labels every subcategory and checks it belongs to its category', () => {
    for (const c of TICKET_CATEGORIES) {
      for (const sub of TICKET_SUBCATEGORIES[c])
        expect(TICKET_SUBCATEGORY_LABELS[sub].ar).toBeTruthy();
    }
    expect(isSubcategoryOf('billing', 'salary')).toBe(true);
    expect(isSubcategoryOf('billing', 'teacher_change')).toBe(false);
  });

  it('builds «تواصل معنا» cards with at most four valid choices each', () => {
    expect(PARENT_CONTACT_CARDS).toHaveLength(4);
    for (const card of [...PARENT_CONTACT_CARDS, ...TEACHER_CONTACT_CARDS]) {
      expect(card.choices.length).toBeLessThanOrEqual(4);
      for (const choice of card.choices) {
        if (choice.subcategory)
          expect(isSubcategoryOf(choice.category, choice.subcategory)).toBe(true);
      }
    }
  });

  it('validates triage, confirm and list queries', () => {
    expect(updateTicketSchema.safeParse({ prUrl: 'https://evil.example.com/pull/1' }).success).toBe(
      false,
    );
    expect(
      updateTicketSchema.safeParse({
        prUrl: 'https://github.com/qarabicacademy/qarabic-app/pull/7',
      }).success,
    ).toBe(true);
    expect(confirmTicketSchema.safeParse({ resolved: false }).success).toBe(false);
    expect(ticketListQuerySchema.parse({ category: 'billing,classes' }).category).toEqual([
      'billing',
      'classes',
    ]);
    expect(inboxQuerySchema.parse({}).status).toBe('open');
    expect(inboxQuerySchema.parse({ assignee: '12' }).assignee).toBe(12);
  });

  it('validates the support settings', () => {
    expect(
      SUPPORT_SETTING_RULES['support.queue_by_category'].safeParse({
        'teacher.teacher_feedback': 'complaints',
      }).success,
    ).toBe(true);
    expect(
      SUPPORT_SETTING_RULES['support.queue_by_category'].safeParse({ 'billing.makeup': 'billing' })
        .success,
    ).toBe(false);
    expect(updateSupportSettingsSchema.safeParse({}).success).toBe(false);
    expect(
      updateSupportSettingsSchema.safeParse({
        'support.working_hours': {
          timezone: 'Africa/Cairo',
          days: [1],
          start: '10:00',
          end: '24:00',
        },
      }).success,
    ).toBe(true);
  });
});
