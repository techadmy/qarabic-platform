import { SUPPORT_SETTING_DEFAULTS } from '../../support/settings-defaults.js';
import { bool, camelizeJson, int, json, oneOf, type Row, str, text } from '../convert.js';
import {
  batch,
  type MapContext,
  type ModuleMapper,
  type SelfRef,
  type TargetBatch,
} from '../plan.js';
import { fit, stamps, t } from './people.js';

const CATEGORIES = ['classes', 'teacher', 'billing', 'technical', 'suggestion', 'other'] as const;
const QUEUES = ['scheduling', 'billing', 'complaints', 'tech', 'product', 'general'] as const;

/** Laravel `encryptString` WhatsApp number → new `v1:` cipher text (null when it cannot be read). */
function moveSecret(ctx: MapContext, id: number, stored: string | null): string | null {
  if (!stored) return null;
  const plain = ctx.opts.legacyCipher?.decrypt(stored) ?? null;
  if (plain === null) {
    ctx.report.change(
      'feedback_tickets',
      id,
      'contact_phone cannot be decrypted (LEGACY_APP_KEY): left empty; contact_hash still groups the sender',
    );
    return null;
  }
  return ctx.opts.targetCipher.encrypt(plain);
}

export const supportMapper: ModuleMapper = {
  name: 'support',
  sources: [
    'feedback_tickets',
    'feedback_comments',
    'feedback_attachments',
    'whatsapp_inbound_messages',
  ],
  dependsOn: ['people'],
  tables: ['tickets', 'ticket_comments', 'ticket_attachments', 'whatsapp_inbound_messages'],
  map(ctx: MapContext): TargetBatch[] {
    const out: TargetBatch[] = [];
    const queueOf = SUPPORT_SETTING_DEFAULTS['support.queue_by_category'];
    const tickets: Row[] = [];
    const dup: SelfRef = { column: 'duplicate_of_id', pairs: [] };
    for (const r of ctx.rows('feedback_tickets')) {
      const id = int(r, 'id')!;
      let category = oneOf(str(r, 'category'), CATEGORIES);
      if (!category) {
        category = 'other';
        ctx.report.change('feedback_tickets', id, `no category ("${str(r, 'category')}"): other`);
      }
      const sub = text(r, 'subcategory');
      let queue = oneOf(str(r, 'queue'), QUEUES);
      if (!queue) {
        queue =
          oneOf(queueOf[`${category}.${sub ?? ''}`] ?? queueOf[category] ?? 'general', QUEUES) ??
          'general';
        ctx.report.change('feedback_tickets', id, `no queue: ${queue} (support.queue_by_category)`);
      }
      const status =
        oneOf(str(r, 'status'), [
          'new',
          'triaged',
          'in_progress',
          'needs_info',
          'fixed',
          'verified',
          'wont_fix',
        ] as const) ?? 'new';
      const closed = status === 'verified' || status === 'wont_fix';
      let closedAt = t(ctx, r.closed_at);
      if (closed && !closedAt) {
        closedAt = t(ctx, r.verified_at) ?? t(ctx, r.fixed_at) ?? stamps(ctx, r).updatedAt;
        ctx.report.change(
          'feedback_tickets',
          id,
          `status ${status} without closed_at: set from verified/fixed/updated time`,
        );
      } else if (!closed && closedAt) {
        ctx.report.change(
          'feedback_tickets',
          id,
          `status ${status} is open but closed_at was set: cleared (the new schema closes only verified / wont_fix)`,
        );
        closedAt = null;
      }
      let subjectType = oneOf(str(r, 'subject_type'), ['session', 'invoice', 'student'] as const);
      let subjectId = int(r, 'subject_id');
      if ((subjectType === null) !== (subjectId === null)) {
        ctx.report.change('feedback_tickets', id, 'subject type/id incomplete: cleared');
        subjectType = null;
        subjectId = null;
      }
      const d = int(r, 'duplicate_of_id');
      if (d !== null) dup.pairs.push([id, d]);
      tickets.push({
        id,
        channel:
          oneOf(str(r, 'channel'), ['in_app', 'whatsapp', 'staff', 'phone'] as const) ?? 'in_app',
        type: oneOf(str(r, 'type'), ['bug', 'feature'] as const) ?? 'bug',
        category,
        subcategory: fit(ctx, 'feedback_tickets', id, 'subcategory', sub, 40),
        subjectType,
        subjectId,
        queue,
        visibility: oneOf(str(r, 'visibility'), ['normal', 'restricted'] as const) ?? 'normal',
        familyId: ctx.ref('families', int(r, 'family_id'), 'feedback_tickets', id, 'family_id'),
        teacherId: ctx.ref('teachers', int(r, 'teacher_id'), 'feedback_tickets', id, 'teacher_id'),
        slaDueAt: t(ctx, r.sla_due_at),
        firstResponseAt: t(ctx, r.first_response_at),
        slaBreachNotifiedAt: t(ctx, r.sla_breach_notified_at),
        priority: oneOf(str(r, 'priority'), ['p0', 'p1', 'p2', 'p3'] as const),
        status,
        title: fit(ctx, 'feedback_tickets', id, 'title', text(r, 'title') ?? `Ticket ${id}`, 160),
        description: str(r, 'description') ?? '',
        reporterId: ctx.has('users', int(r, 'reporter_id')) ? int(r, 'reporter_id') : null,
        reporterRole: fit(
          ctx,
          'feedback_tickets',
          id,
          'reporter_role',
          text(r, 'reporter_role'),
          100,
        ),
        contactPhone: moveSecret(ctx, id, str(r, 'contact_phone')),
        contactHash: text(r, 'contact_hash'),
        area: fit(ctx, 'feedback_tickets', id, 'area', text(r, 'area'), 40),
        context: json(r, 'context') ?? undefined,
        prUrl: fit(ctx, 'feedback_tickets', id, 'pr_url', text(r, 'pr_url'), 300),
        resolution: text(r, 'resolution'),
        duplicateOfId: null,
        assigneeId: ctx.has('users', int(r, 'assignee_id')) ? int(r, 'assignee_id') : null,
        triagedAt: t(ctx, r.triaged_at),
        fixedAt: t(ctx, r.fixed_at),
        verifiedAt: t(ctx, r.verified_at),
        closedAt,
        lastPublicAt: t(ctx, r.last_public_at),
        reporterSeenAt: t(ctx, r.reporter_seen_at),
        whatsappWindowUntil: t(ctx, r.whatsapp_window_until),
        ...stamps(ctx, r),
      });
    }
    ctx.remember(
      'tickets',
      tickets.map((x) => x.id as number),
    );
    dup.pairs = dup.pairs.filter(([, ref]) => ctx.has('tickets', ref));
    out.push(
      batch(
        'tickets',
        'ticket',
        'feedback_tickets',
        ctx.rows('feedback_tickets').length,
        tickets,
        true,
        [dup],
      ),
    );

    const comments: Row[] = [];
    for (const r of ctx.rows('feedback_comments')) {
      const id = int(r, 'id')!;
      if (!ctx.has('tickets', int(r, 'ticket_id'))) {
        ctx.report.skip('feedback_comments', id, 'ticket not imported');
        continue;
      }
      comments.push({
        id,
        ticketId: int(r, 'ticket_id'),
        authorId: ctx.has('users', int(r, 'author_id')) ? int(r, 'author_id') : null,
        authorLabel: fit(ctx, 'feedback_comments', id, 'author_label', text(r, 'author_label'), 60),
        kind:
          oneOf(str(r, 'kind'), [
            'comment',
            'status',
            'priority',
            'assignment',
            'system',
          ] as const) ?? 'comment',
        body: str(r, 'body'),
        internal: bool(r, 'internal') ?? false,
        meta: camelizeJson(json(r, 'meta')) ?? undefined,
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    ctx.remember(
      'ticket_comments',
      comments.map((c) => c.id as number),
    );
    out.push(
      batch(
        'ticket_comments',
        'ticketComment',
        'feedback_comments',
        ctx.rows('feedback_comments').length,
        comments,
      ),
    );

    // Metadata only: the files stay on the Laravel disk (storage/app/<path>) and are copied at cut-over.
    const files: Row[] = [];
    for (const r of ctx.rows('feedback_attachments')) {
      const id = int(r, 'id')!;
      const source = oneOf(str(r, 'source'), ['screenshot', 'upload', 'whatsapp'] as const);
      if (!ctx.has('tickets', int(r, 'ticket_id')) || !source) {
        ctx.report.skip('feedback_attachments', id, 'ticket not imported or unknown source');
        continue;
      }
      files.push({
        id,
        ticketId: int(r, 'ticket_id'),
        commentId: ctx.has('ticket_comments', int(r, 'comment_id')) ? int(r, 'comment_id') : null,
        source,
        storageKey: str(r, 'path'),
        mime: str(r, 'mime'),
        size: int(r, 'size'),
        sha256: str(r, 'sha256'),
        originalName: fit(
          ctx,
          'feedback_attachments',
          id,
          'original_name',
          text(r, 'original_name'),
          150,
        ),
        prunedAt: t(ctx, r.pruned_at),
        createdAt: stamps(ctx, r).createdAt,
      });
    }
    if (files.length) {
      ctx.report.warn(
        'feedback_attachments',
        `${files.length} file(s): only metadata is imported; copy the files from the Laravel disk (storage/app/<path>) to STORAGE_LOCAL_DIR/<path> at cut-over`,
      );
    }
    out.push(
      batch(
        'ticket_attachments',
        'ticketAttachment',
        'feedback_attachments',
        ctx.rows('feedback_attachments').length,
        files,
      ),
    );

    const wa = ctx.rows('whatsapp_inbound_messages').map((r) => ({
      id: int(r, 'id')!,
      waMessageId: str(r, 'wa_message_id'),
      fromHash: str(r, 'from_hash'),
      type: fit(ctx, 'whatsapp_inbound_messages', r.id, 'type', text(r, 'type') ?? 'other', 16),
      status: fit(
        ctx,
        'whatsapp_inbound_messages',
        r.id,
        'status',
        text(r, 'status') ?? 'received',
        32,
      ),
      userId: int(r, 'user_id'),
      ticketId: int(r, 'ticket_id'),
      error: fit(ctx, 'whatsapp_inbound_messages', r.id, 'error', text(r, 'error'), 200),
      receivedAt: t(ctx, r.received_at) ?? stamps(ctx, r).createdAt,
      ...stamps(ctx, r),
    }));
    out.push(
      batch(
        'whatsapp_inbound_messages',
        'whatsAppInboundMessage',
        'whatsapp_inbound_messages',
        ctx.rows('whatsapp_inbound_messages').length,
        wa,
      ),
    );
    return out;
  },
};
