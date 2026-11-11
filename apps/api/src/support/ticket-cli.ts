import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  CLOSED_TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  TICKET_STATUSES,
  type TicketStatus,
  updateTicketSchema,
} from '@qarabic/shared';
import { ApiException } from '../common/errors.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isoZ } from '../schedule/time.js';
import { extensionFor, FileStorage } from './storage.js';
import { type Actor, TicketsService } from './tickets.service.js';

export interface CliResult {
  code: number;
  out: string[];
}

const csv = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

/** `--name=value` options and `--flag` switches. */
export function parseOptions(args: string[]): {
  positional: string[];
  options: Record<string, string>;
} {
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of args) {
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(arg);
    if (m) options[m[1]!] = m[2] ?? 'true';
    else positional.push(arg);
  }
  return { positional, options };
}

/** Errors of the API (422 per field, 404) as CLI lines. */
function errorLines(error: unknown): string[] {
  if (error instanceof ApiException) {
    const body = error.getResponse() as { message: string; errors?: Record<string, string[]> };
    return body.errors
      ? Object.entries(body.errors).map(([field, messages]) => `${field}: ${messages.join(' ')}`)
      : [body.message];
  }
  throw error;
}

/**
 * The ticket queue from the server (docs/22 §7, D100), port of Laravel `tickets:list`,
 * `tickets:show` and `tickets:triage` (split into `tickets:status` and `tickets:reply`). Same
 * validation and lifecycle rules as the API (`updateTicketSchema` + `TicketsService`); writes are
 * recorded with the label "Claude" (or `--as`). Read-only commands print names and roles only, no
 * contact data.
 */
@Injectable()
export class TicketCli {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
    private readonly storage: FileStorage,
  ) {}

  /** `tickets:list [--status=open|closed|all|<status>,…] [--priority=p0,…,none] [--type=] [--category=] [--channel=] [--queue=] [--since=YYYY-MM-DD] [--limit=50] [--json]` */
  async list(args: string[]): Promise<CliResult> {
    const { options } = parseOptions(args);
    const statuses = new Set<TicketStatus>();
    for (const s of csv(options.status).length ? csv(options.status) : ['open']) {
      if (s === 'open') OPEN_TICKET_STATUSES.forEach((x) => statuses.add(x));
      else if (s === 'closed') CLOSED_TICKET_STATUSES.forEach((x) => statuses.add(x));
      else if (s === 'all') TICKET_STATUSES.forEach((x) => statuses.add(x));
      else if ((TICKET_STATUSES as readonly string[]).includes(s)) statuses.add(s as TicketStatus);
      else return { code: 2, out: [`Unknown status: ${s}`] };
    }
    const priorities = csv(options.priority);
    const and: Prisma.TicketWhereInput[] = [{ status: { in: [...statuses] } }];
    if (priorities.length) {
      const named = priorities.filter((p) => p !== 'none') as Array<'p0' | 'p1' | 'p2' | 'p3'>;
      and.push({
        OR: [
          ...(named.length ? [{ priority: { in: named } }] : []),
          ...(priorities.includes('none') ? [{ priority: null }] : []),
        ],
      });
    }
    if (options.type) and.push({ type: options.type as 'bug' | 'feature' });
    if (options.category) and.push({ category: options.category as never });
    if (options.channel) and.push({ channel: options.channel as never });
    if (options.queue) and.push({ queue: options.queue as never });
    if (options.since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(options.since))
        return { code: 2, out: ['--since must be YYYY-MM-DD.'] };
      and.push({ createdAt: { gte: new Date(`${options.since}T00:00:00Z`) } });
    }
    const rows = await this.prisma.ticket.findMany({
      where: { AND: and },
      include: {
        reporter: { select: { name: true } },
        assignee: { select: { name: true } },
        _count: { select: { attachments: true } },
      },
      orderBy: [{ priority: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: Math.min(500, Math.max(1, Number(options.limit ?? 50) || 50)),
    });
    const table = rows.map((t) => ({
      id: t.id,
      created: isoZ(t.createdAt)!.slice(0, 16).replace('T', ' '),
      status: t.status,
      priority: t.priority ?? '-',
      type: t.type,
      category: t.category,
      queue: t.queue,
      area: t.area ?? '-',
      channel: t.channel,
      reporter: `${t.reporter?.name ?? '?'} (${t.reporterRole ?? '-'})`,
      assignee: t.assignee?.name ?? '-',
      files: t._count.attachments,
      title: t.title,
    }));
    if (options.json) return { code: 0, out: [JSON.stringify(table, null, 2)] };
    if (!table.length) return { code: 0, out: ['No tickets.'] };
    return {
      code: 0,
      out: table.map(
        (r) =>
          `#${r.id} [${r.status}] ${r.priority} ${r.category}/${r.queue} ${r.channel} · ${r.reporter} → ${r.assignee} · ${r.files} file(s) · ${r.title}`,
      ),
    };
  }

  /** `tickets:show <id> [--json] [--attachments=/tmp/ticket-12]`: context + full timeline (internal included). */
  async show(args: string[]): Promise<CliResult> {
    const { positional, options } = parseOptions(args);
    const id = Number(positional[0]);
    const t =
      Number.isInteger(id) && id > 0
        ? await this.prisma.ticket.findUnique({
            where: { id },
            include: {
              reporter: { select: { name: true } },
              assignee: { select: { name: true } },
              comments: { orderBy: { id: 'asc' }, include: { author: { select: { name: true } } } },
              attachments: { orderBy: { id: 'asc' } },
            },
          })
        : null;
    if (!t) return { code: 1, out: ['Ticket not found.'] };
    const data = {
      id: t.id,
      status: t.status,
      priority: t.priority,
      type: t.type,
      category: t.category,
      subcategory: t.subcategory,
      subject: t.subjectType ? `${t.subjectType}:${t.subjectId}` : null,
      queue: t.queue,
      visibility: t.visibility,
      channel: t.channel,
      area: t.area,
      title: t.title,
      reporter: t.reporter?.name ?? null,
      reporterRole: t.reporterRole,
      assignee: t.assignee?.name ?? null,
      prUrl: t.prUrl,
      resolution: t.resolution,
      duplicateOf: t.duplicateOfId,
      slaDueAt: isoZ(t.slaDueAt),
      createdAt: isoZ(t.createdAt),
      description: t.description,
      context: t.context,
      attachments: t.attachments.map((a) => ({
        id: a.id,
        source: a.source,
        mime: a.mime,
        size: a.size,
        commentId: a.commentId,
        pruned: a.prunedAt !== null,
      })),
      timeline: t.comments.map((c) => ({
        at: isoZ(c.createdAt),
        by: c.author?.name ?? c.authorLabel,
        kind: c.kind,
        internal: c.internal,
        meta: c.meta,
        body: c.body,
      })),
    };
    const out: string[] = [];
    if (options.attachments) {
      await mkdir(options.attachments, { recursive: true });
      for (const a of t.attachments.filter((x) => x.prunedAt === null)) {
        const bytes = await this.storage.get(a.storageKey);
        if (bytes) {
          await writeFile(
            join(options.attachments, `${t.id}-${a.id}.${extensionFor(a.mime)}`),
            bytes,
          );
        }
      }
      out.push(`Attachments copied to ${options.attachments}`);
    }
    if (options.json) return { code: 0, out: [...out, JSON.stringify(data, null, 2)] };
    const topic = `${data.category}${data.subcategory ? `/${data.subcategory}` : ''}${data.subject ? ` → ${data.subject}` : ''}`;
    out.push(
      `#${data.id} [${data.status}] ${data.priority ?? '-'} ${data.type} · ${topic} · ${data.queue} · ${data.channel} · ${data.area ?? '-'}`,
      `Title: ${data.title}`,
      `Reporter: ${data.reporter ?? '-'} (${data.reporterRole ?? '-'})  Assignee: ${data.assignee ?? '-'}`,
      `PR: ${data.prUrl ?? '-'}  SLA due: ${data.slaDueAt ?? '-'}`,
      '',
      data.description,
      '',
      `Context: ${JSON.stringify(data.context)}`,
      `Attachments: ${data.attachments.length}`,
      '',
      ...data.timeline.map(
        (r) =>
          `- ${r.at} ${r.internal ? '[internal] ' : ''}${r.by ?? '-'} ${r.kind}${r.meta ? ` ${JSON.stringify(r.meta)}` : ''}${r.body ? `: ${r.body}` : ''}`,
      ),
    );
    return { code: 0, out };
  }

  /**
   * `tickets:status <id> [--status=] [--priority=p0..p3|none] [--type=] [--category=] [--queue=]
   * [--area=] [--title=] [--pr=URL] [--resolution=] [--duplicate-of=ID] [--note=] [--assign=email|none]
   * [--as=Claude]`
   */
  async status(args: string[]): Promise<CliResult> {
    const { positional, options } = parseOptions(args);
    const id = Number(positional[0]);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !(await this.prisma.ticket.findUnique({ where: { id } }))
    ) {
      return { code: 1, out: ['Ticket not found.'] };
    }
    const raw: Record<string, unknown> = {};
    const map: Record<string, string> = {
      status: 'status',
      priority: 'priority',
      type: 'type',
      category: 'category',
      queue: 'queue',
      area: 'area',
      title: 'title',
      pr: 'prUrl',
      resolution: 'resolution',
      note: 'note',
    };
    for (const [opt, key] of Object.entries(map)) {
      if (options[opt] !== undefined && options[opt] !== '') raw[key] = options[opt];
    }
    if (raw.priority === 'none') raw.priority = null;
    if (options['duplicate-of']) raw.duplicateOfId = Number(options['duplicate-of']);
    if (options.assign) {
      if (options.assign === 'none') {
        raw.assigneeId = null;
      } else {
        const user = await this.prisma.user.findUnique({
          where: { email: options.assign.toLowerCase() },
          select: { id: true },
        });
        if (!user) return { code: 1, out: ['No user with that email.'] };
        raw.assigneeId = user.id;
      }
    }
    const parsed = updateTicketSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        code: 1,
        out: parsed.error.issues.map((i) => `${i.path.join('.') || '_'}: ${i.message}`),
      };
    }
    if (!Object.keys(parsed.data).length) return { code: 2, out: ['Nothing to change.'] };
    try {
      await this.tickets.update(id, parsed.data, this.actor(options));
    } catch (error) {
      return { code: 1, out: errorLines(error) };
    }
    const t = await this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    return { code: 0, out: [`#${t.id} → ${t.status} ${t.priority ?? '-'}`] };
  }

  /** `tickets:reply <id> --body="…" [--internal] [--as=Claude]`: a public reply or an internal note. */
  async reply(args: string[]): Promise<CliResult> {
    const { positional, options } = parseOptions(args);
    const id = Number(positional[0]);
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !(await this.prisma.ticket.findUnique({ where: { id } }))
    ) {
      return { code: 1, out: ['Ticket not found.'] };
    }
    const body = (options.body ?? '').trim();
    if (!body || body === 'true') return { code: 2, out: ['body: --body="…" is required.'] };
    if (body.length > 5000) return { code: 1, out: ['body: At most 5000 characters.'] };
    const internal = options.internal === 'true' || options.internal === '1';
    await this.tickets.comment(id, this.actor(options), body, internal);
    return { code: 0, out: [`#${id}: ${internal ? 'internal note' : 'reply'} added.`] };
  }

  private actor(options: Record<string, string>): Actor {
    const label = (options.as ?? 'Claude').trim().slice(0, 60) || 'Claude';
    return { user: null, label };
  }
}
