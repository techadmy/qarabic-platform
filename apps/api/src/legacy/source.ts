import type { Row } from './convert.js';

/** Where the legacy rows come from: the Laravel MySQL database, or memory (tests, CI has no MySQL). */
export interface LegacySource {
  /** Tables that exist in the source. */
  tables(): Promise<string[]>;
  /** Every row of a table, ordered by its primary key. A missing table → []. */
  rows(table: string): Promise<Row[]>;
  /** Row count of a table (0 when it does not exist). */
  count(table: string): Promise<number>;
  /** Short label for logs and the report (host/port/database only, never a password). */
  readonly label: string;
  close(): Promise<void>;
}

/** In-memory source: `{ table: rows[] }`. */
export class MemorySource implements LegacySource {
  readonly label = 'memory';

  constructor(private readonly data: Record<string, Row[]>) {}

  tables(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.data));
  }

  rows(table: string): Promise<Row[]> {
    return Promise.resolve((this.data[table] ?? []).map((r) => ({ ...r })));
  }

  count(table: string): Promise<number> {
    return Promise.resolve(this.data[table]?.length ?? 0);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** `mysql://user:secret@host:3306/db` → `mysql://host:3306/db` (for logs and reports). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
