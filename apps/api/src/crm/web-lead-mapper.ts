import { Injectable } from '@nestjs/common';
import type { wpformsLeadSchema } from '@qarabic/shared';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { countryOfPhone } from './calling-codes.js';
import { CrmConfig } from './crm.config.js';
import type { IntakeData, LeadChild } from './lead.types.js';

type Payload = z.output<typeof wpformsLeadSchema>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cut = (v: string, max: number) => [...v].slice(0, max).join('');

export const externalRef = (formId: number, entryId: number) => `wpforms:${formId}:${entryId}`;

/**
 * A WPForms entry of the website's free-trial page → intake data (docs/33 §3.1). Port of Laravel
 * `WebLeadMapper`. Field ids on form 4823: 1 name, 3 email, 5 phone (E.164), 11 course_for
 * (You / Your Kids / Both), 12 children_count, 13 student_age, 10 course, 9 notes.
 */
@Injectable()
export class WebLeadMapper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: CrmConfig,
  ) {}

  async fromWpforms(payload: Payload): Promise<IntakeData> {
    const f = payload.fields;
    const text = (value: string | null | undefined, max: number): string | null =>
      typeof value === 'string' && value.trim() !== '' ? cut(value.trim(), max) : null;

    const name = text(f.name, 120) ?? '—';
    const email = text(f.email, 190);
    const phone = text(f.phone, 40);
    const courseLabel = text(f.course, 120);
    const courseId = await this.courseId(courseLabel);
    const courseFor = text(f.course_for, 40);
    const ages = parseAges(f.student_age);
    const children = buildChildren(courseFor, f.children_count, ages, name, courseId);

    const details = [
      courseFor ? `Course for: ${courseFor}` : null,
      f.children_count ? `Children: ${cut(String(f.children_count), 10)}` : null,
      f.student_age ? `Age: ${cut(String(f.student_age), 60)}` : null,
    ].filter(Boolean);
    const notes = text(f.notes, 4500);
    const message =
      ((details.length ? `[${details.join(' · ')}]` : '') + (notes ? `\n${notes}` : '')).trim() ||
      null;

    return {
      parentName: name,
      email: email && EMAIL.test(email) ? email : null,
      phone,
      countryCode: countryOfPhone(phone),
      courseInterest: courseLabel,
      children,
      message,
      site: `wpforms:${payload.form_id}`,
      externalRef: externalRef(payload.form_id, payload.entry_id),
      utm: utmOf(payload.page_url, payload.referer),
      source: 'web_form',
    };
  }

  /** The configured map first (`WEB_LEADS_COURSE_MAP`), then an exact course name; null = text only. */
  async courseId(label: string | null): Promise<number | null> {
    if (label === null) return null;
    const key = label.trim().toLowerCase();
    const mapped = this.config.courseMap[key];
    if (mapped && Number.isInteger(mapped)) {
      const hit = await this.prisma.course.findUnique({
        where: { id: mapped },
        select: { id: true },
      });
      if (hit) return hit.id;
    }
    const byName = await this.prisma.course.findFirst({
      where: {
        OR: [
          { nameEn: { equals: key, mode: 'insensitive' } },
          { nameAr: { equals: label.trim(), mode: 'insensitive' } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return byName?.id ?? null;
  }
}

/** Every 2–99 number in the free-text age field ("8 and 11" → [8, 11]). */
export function parseAges(raw: string | null | undefined): number[] {
  if (typeof raw !== 'string') return [];
  return [...raw.matchAll(/\d{1,2}/g)].map((m) => Number(m[0])).filter((a) => a >= 2 && a <= 99);
}

export function buildChildren(
  courseFor: string | null,
  count: string | null | undefined,
  ages: number[],
  parentName: string,
  courseId: number | null,
): LeadChild[] {
  const forWho = (courseFor ?? '').toLowerCase();
  const raw = count ?? '';
  const n = /^\s*\d+(\.\d+)?\s*$/.test(raw)
    ? Number(raw)
    : Number(/(\d+)/.exec(raw)?.[1] ?? Number.NaN);
  const kids = Number.isFinite(n) ? Math.max(1, Math.min(10, Math.trunc(n))) : 1;
  const entries: LeadChild[] = [];
  if (forWho.includes('you') && !forWho.includes('kid')) {
    // "You": the parent is the learner.
    entries.push({ name: parentName, ...(ages[0] !== undefined ? { age: ages[0] } : {}) });
  } else {
    if (forWho.includes('both')) entries.push({ name: parentName });
    for (let i = 0; i < kids; i++) {
      entries.push(ages[i] !== undefined ? { age: ages[i]! } : {});
    }
  }
  return entries.map((c) => (courseId ? { ...c, courseId } : c));
}

/** utm_* from the page URL, plus the page (without its query) and the referer. */
export function utmOf(
  pageUrl: string | null | undefined,
  referer: string | null | undefined,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (typeof pageUrl === 'string' && pageUrl !== '') {
    let params: URLSearchParams | null = null;
    try {
      params = new URL(pageUrl).searchParams;
    } catch {
      const q = pageUrl.indexOf('?');
      params = q >= 0 ? new URLSearchParams(pageUrl.slice(q + 1)) : null;
    }
    for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
      const v = params?.get(`utm_${k}`);
      if (v) out[k] = cut(v, 100);
    }
    out.page = cut(pageUrl.split('?')[0] || pageUrl, 300);
  }
  if (typeof referer === 'string' && referer !== '') out.referer = cut(referer, 300);
  return Object.keys(out).length ? out : null;
}
