import { z } from 'zod';
import { personRefSchema } from './people.js';
import { PARENT_CONTACT_CARDS, TEACHER_CONTACT_CARDS } from './support.js';
import { TICKET_CHANNELS } from './tickets.js';

/**
 * S5 of docs/32 (§7): moving families off WhatsApp. Every «تواصل معنا» action has a deep link
 * (`/contact?card=…&choice=…&session=…`) that opens the right form after sign-in; staff paste it
 * with a saved reply instead of handling the request on WhatsApp; the channel report shows how
 * much still comes in on behalf (target < 10 %). The official number's auto-reply waits for B50:
 * nothing is ever sent to a family from here.
 */

type Labels<T extends string> = Record<T, { ar: string; en: string }>;
const id = z.number().int().positive();

/** What a deep link opens: the hub, a card, or a choice (with its class / invoice / child). */
export const contactLinkSchema = z
  .object({
    card: z.string().max(40).optional(),
    choice: z.string().max(40).optional(),
    sessionId: id.optional(),
    invoiceId: id.optional(),
    studentId: id.optional(),
  })
  .superRefine((v, ctx) => {
    const cards = [...PARENT_CONTACT_CARDS, ...TEACHER_CONTACT_CARDS];
    const card = v.card ? cards.find((c) => c.key === v.card) : undefined;
    if (v.card && !card) {
      ctx.addIssue({ code: 'custom', path: ['card'], message: 'Unknown card.' });
    }
    if (v.choice && (!card || !card.choices.some((c) => c.key === v.choice))) {
      ctx.addIssue({ code: 'custom', path: ['choice'], message: 'Unknown choice for the card.' });
    }
  });
export type ContactLink = z.infer<typeof contactLinkSchema>;

/** The app path of a deep link (the web opens «تواصل معنا» on it). */
export function contactPath(link: ContactLink): string {
  const q: string[] = [];
  const add = (k: string, v: string | number | undefined) => {
    if (v !== undefined) q.push(`${k}=${encodeURIComponent(String(v))}`);
  };
  add('card', link.card);
  add('choice', link.choice);
  add('session', link.sessionId);
  add('invoice', link.invoiceId);
  add('student', link.studentId);
  return q.length ? `/contact?${q.join('&')}` : '/contact';
}

/** `GET /support/links?familyId=` (`support.view`): ready links to paste for one family. */
export const supportLinksQuerySchema = z.object({ familyId: z.coerce.number().int().positive() });

export const supportLinkItemSchema = z.object({
  key: z.string(),
  label: z.object({ ar: z.string(), en: z.string() }),
  url: z.string(),
  /** e.g. the class time or the invoice number, for the staff member's eyes only. */
  detail: z.string().nullable(),
});
export const supportLinksSchema = z.object({
  family: personRefSchema,
  general: z.array(supportLinkItemSchema),
  classes: z.array(supportLinkItemSchema),
  invoices: z.array(supportLinkItemSchema),
});
export type SupportLinksDto = z.infer<typeof supportLinksSchema>;

// ------------------------------------------------------------------ saved replies

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * A saved reply (Arabic + English). `{link}` is replaced by the reply's deep link and `{name}` by
 * the parent's name when it is rendered for a family.
 */
export const savedReplyInputSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{2,40}$/, 'Use lowercase letters, digits and _.'),
  titleAr: text(120),
  titleEn: text(120),
  bodyAr: text(2000),
  bodyEn: text(2000),
  link: contactLinkSchema.nullable().optional(),
});
export const updateSavedReplySchema = savedReplyInputSchema.partial();
export type SavedReplyInput = z.input<typeof savedReplyInputSchema>;

export const savedReplySchema = z.object({
  id: z.number().int(),
  key: z.string(),
  title: z.object({ ar: z.string(), en: z.string() }),
  body: z.object({ ar: z.string(), en: z.string() }),
  link: contactLinkSchema.nullable(),
  isActive: z.boolean(),
  updatedAt: z.string(),
});
export type SavedReplyDto = z.infer<typeof savedReplySchema>;

/** `POST /support/saved-replies/:id/render`: the text to paste, with the family's link. */
export const renderSavedReplySchema = z.object({
  familyId: id.optional(),
  sessionId: id.optional(),
  invoiceId: id.optional(),
  studentId: id.optional(),
});
export const renderedReplySchema = z.object({
  ar: z.string(),
  en: z.string(),
  url: z.string().nullable(),
});
export type RenderedReplyDto = z.infer<typeof renderedReplySchema>;

// ------------------------------------------------------------------ channel report

export const ON_BEHALF_TARGET_PCT = 10;
export const SUPPORT_REQUEST_ORIGINS = [...TICKET_CHANNELS, 'class_request'] as const;
export type SupportRequestOrigin = (typeof SUPPORT_REQUEST_ORIGINS)[number];
export const SUPPORT_ORIGIN_LABELS: Labels<SupportRequestOrigin> = {
  in_app: { ar: 'من النظام', en: 'In the app' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  staff: { ar: 'نيابةً عن الأسرة', en: 'On behalf' },
  phone: { ar: 'هاتف', en: 'Phone' },
  class_request: { ar: 'طلب على حصة', en: 'Class request' },
};

/** `GET /support/channels?from&to` (`support.view`; default the last 8 weeks). */
export const supportChannelsQuerySchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .superRefine((v, ctx) => {
    if (v.from && v.to && v.to < v.from) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end is before the start.' });
    }
  });

const counts = z.object({
  total: z.number().int(),
  /** Filed by staff for a family or teacher (any channel, tickets and class requests). */
  onBehalf: z.number().int(),
  byOrigin: z.record(z.enum(SUPPORT_REQUEST_ORIGINS), z.number().int()),
});
export const supportChannelsSchema = z.object({
  from: z.string(),
  to: z.string(),
  total: counts.extend({ onBehalfPct: z.number().nullable() }),
  targetPct: z.number(),
  weeks: z.array(counts.extend({ weekStart: z.string() })),
  /** Who still files on behalf, most first. */
  byStaff: z.array(z.object({ user: personRefSchema, count: z.number().int() })),
});
export type SupportChannelsDto = z.infer<typeof supportChannelsSchema>;
