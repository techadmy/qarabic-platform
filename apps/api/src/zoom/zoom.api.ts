import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { ZoomConfig } from './zoom.config.js';

const API = 'https://api.zoom.us/v2';
const TOKEN_URL = 'https://zoom.us/oauth/token';
/** Refresh a token this long before Zoom's expiry (tokens live one hour). */
const TOKEN_MARGIN_MS = 5 * 60_000;
const MAX_TRIES = 4;
const MAX_PAGES = 20;

export interface ZoomResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}
export type ZoomFetch = (req: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
}) => Promise<ZoomResponse>;

/** The network edge, swappable in tests (no request leaves a test). */
@Injectable()
export class ZoomHttp {
  private override: ZoomFetch | null = null;

  use(fake: ZoomFetch | null): void {
    this.override = fake;
  }

  async send(req: Parameters<ZoomFetch>[0]): Promise<ZoomResponse> {
    if (this.override) return this.override(req);
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers, json };
  }
}

export class ZoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PastParticipant {
  /** Zoom user id (empty for guests). */
  userId: string | null;
  participantUuid: string | null;
  name: string;
  email: string | null;
  joinTime: string;
  leaveTime: string | null;
}

/** Zoom user type 2 = licensed. */
const LICENSED = 2;

export interface ZoomAccountUser {
  id: string;
  email: string;
  displayName: string | null;
  pmi: string | null;
  personalMeetingUrl: string | null;
}

/**
 * Z1: a minimal Server-to-Server OAuth client (account_credentials). The token is cached for under
 * an hour; 429 and 5xx answers back off (Retry-After or 1 s, 2 s, 4 s). Keys never reach a log.
 */
@Injectable()
export class ZoomApi {
  private readonly logger = new Logger(ZoomApi.name);
  private token: { value: string; until: number } | null = null;

  constructor(
    private readonly config: ZoomConfig,
    private readonly http: ZoomHttp,
    private readonly clock: Clock,
  ) {}

  /** Tests and a key change: forget the cached token. */
  forgetToken(): void {
    this.token = null;
  }

  private async accessToken(): Promise<string> {
    const now = this.clock.nowMs();
    if (this.token && this.token.until > now) return this.token.value;
    if (!this.config.enabled) throw new ZoomApiError('Zoom tracking is off.', 503);
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      'base64',
    );
    const res = await this.http.send({
      method: 'POST',
      url: `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(
        this.config.accountId!,
      )}`,
      headers: { Authorization: `Basic ${basic}` },
    });
    const body = (res.json ?? {}) as { access_token?: string; expires_in?: number };
    if (res.status !== 200 || !body.access_token) {
      // The status only: the body may echo the client id.
      throw new ZoomApiError(`Zoom token request failed: HTTP ${res.status}`, res.status);
    }
    const ttl = Math.min((body.expires_in ?? 3600) * 1000, 3_600_000) - TOKEN_MARGIN_MS;
    this.token = { value: body.access_token, until: now + Math.max(ttl, 60_000) };
    return this.token.value;
  }

  /** GET with a bearer token; retries 429 / 5xx with backoff, and a 401 once with a new token. */
  async get(path: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const res = await this.http.send({
        method: 'GET',
        url: `${API}${path}`,
        headers: { Authorization: `Bearer ${await this.accessToken()}` },
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.forgetToken();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
        const retryAfter = Number(res.headers['retry-after']);
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** (attempt - 1);
        this.logger.warn(
          `Zoom ${res.status} on ${path.split('?')[0]}: retry ${attempt} in ${wait} ms`,
        );
        await sleep(Math.min(wait, 30_000));
        continue;
      }
      if (res.status >= 300) {
        throw new ZoomApiError(
          `Zoom GET ${path.split('?')[0]} failed: HTTP ${res.status}`,
          res.status,
        );
      }
      return res.json;
    }
  }

  /** `GET /users/{id or email}`: the user's id, email and personal meeting id. */
  async user(idOrEmail: string): Promise<{ id: string; email: string; pmi: string | null }> {
    const u = (await this.get(`/users/${encodeURIComponent(idOrEmail)}`)) as {
      id: string;
      email: string;
      pmi?: number | string;
    };
    return { id: u.id, email: u.email, pmi: u.pmi !== undefined ? String(u.pmi) : null };
  }

  /**
   * D151 (b): the account's active users of type 2 (licensed), every page (`GET /users`), then
   * each one's PMI and personal meeting link (`GET /users/{id}`). Scopes: `user:read:list_users:admin`
   * and `user:read:user:admin` (docs/42 §6.1).
   */
  async licensedUsers(): Promise<ZoomAccountUser[]> {
    const ids: string[] = [];
    let next = '';
    let pages = 0;
    do {
      if (++pages > MAX_PAGES) {
        this.logger.warn(`Zoom users passed ${MAX_PAGES} pages; stopped.`);
        break;
      }
      const page = (await this.get(
        `/users?status=active&page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`,
      )) as { users?: Array<{ id?: string; type?: number }>; next_page_token?: string };
      for (const u of page.users ?? []) if (u.id && u.type === LICENSED) ids.push(u.id);
      next = page.next_page_token ?? '';
    } while (next);

    const out: ZoomAccountUser[] = [];
    for (const id of ids) {
      const u = (await this.get(`/users/${encodeURIComponent(id)}`)) as {
        id: string;
        email: string;
        type?: number;
        status?: string;
        display_name?: string;
        first_name?: string;
        last_name?: string;
        pmi?: number | string;
        personal_meeting_url?: string;
      };
      if (u.type !== LICENSED || (u.status && u.status !== 'active')) continue;
      const name = u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || null;
      out.push({
        id: u.id,
        email: u.email,
        displayName: name,
        pmi: u.pmi !== undefined && u.pmi !== null ? String(u.pmi) : null,
        personalMeetingUrl: u.personal_meeting_url || null,
      });
    }
    return out;
  }

  /**
   * `GET /past_meetings/{uuid}/participants` (every page). A uuid that starts with `/` or holds
   * `//` must be encoded twice (Zoom's rule).
   */
  async pastParticipants(meetingUuid: string): Promise<PastParticipant[]> {
    const once = encodeURIComponent(meetingUuid);
    const id =
      meetingUuid.startsWith('/') || meetingUuid.includes('//') ? encodeURIComponent(once) : once;
    const out: PastParticipant[] = [];
    let next = '';
    let pages = 0;
    do {
      // A 1-to-1 class has a handful of rows; a runaway paging loop stops here.
      if (++pages > MAX_PAGES) {
        this.logger.warn(`Zoom participants of a meeting passed ${MAX_PAGES} pages; stopped.`);
        break;
      }
      const page = (await this.get(
        `/past_meetings/${id}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`,
      )) as {
        participants?: Array<{
          id?: string;
          user_id?: string;
          participant_user_id?: string;
          name?: string;
          user_email?: string;
          join_time?: string;
          leave_time?: string;
        }>;
        next_page_token?: string;
      };
      for (const p of page.participants ?? []) {
        if (!p.join_time) continue;
        out.push({
          userId: p.id || p.participant_user_id || null,
          participantUuid: p.user_id ?? null,
          name: p.name ?? '',
          email: p.user_email || null,
          joinTime: p.join_time,
          leaveTime: p.leave_time ?? null,
        });
      }
      next = page.next_page_token ?? '';
    } while (next);
    return out;
  }
}
