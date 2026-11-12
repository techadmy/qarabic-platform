import mysql from 'mysql2/promise';
import type { Row } from './convert.js';
import { type LegacySource, redactUrl } from './source.js';

/** Primary keys that are not `id`. */
const ORDER_BY: Record<string, string> = {
  app_settings: '`key`',
  invoice_sequences: '`year`',
  quran_surahs: '`number`',
  role_has_permissions: '`role_id`, `permission_id`',
  model_has_roles: '`role_id`, `model_id`',
  model_has_permissions: '`permission_id`, `model_id`',
  password_reset_tokens: '`email`',
  cache: '`key`',
  cache_locks: '`key`',
  sessions: '`id`',
};

/**
 * Read-only MySQL reader (mysql2). Dates come back as the strings MySQL stores (`dateStrings`),
 * so no driver time zone is applied; the mappers interpret them (convert.ts `utc`). The session
 * is left on the server's default `time_zone`, exactly like Laravel's connection (it sets none),
 * so TIMESTAMP columns read back as the wall times Laravel wrote. Every statement runs in a
 * READ ONLY transaction: the importer can never write to the source.
 */
export class MySqlSource implements LegacySource {
  readonly label: string;

  private constructor(
    private readonly conn: mysql.Connection,
    url: string,
  ) {
    this.label = redactUrl(url);
  }

  static async connect(url: string): Promise<MySqlSource> {
    const conn = await mysql.createConnection({
      uri: url,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      charset: 'utf8mb4',
      multipleStatements: false,
    });
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    return new MySqlSource(conn, url);
  }

  async tables(): Promise<string[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    return rows.map((r) => String(r.t));
  }

  async rows(table: string): Promise<Row[]> {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`Bad table name ${table}`);
    if (!(await this.tables()).includes(table)) return [];
    const [cols] = await this.conn.query<mysql.RowDataPacket[]>(
      'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      [table],
    );
    const order = ORDER_BY[table] ?? (cols.some((c) => c.c === 'id') ? '`id`' : '1');
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT * FROM \`${table}\` ORDER BY ${order}`,
    );
    return rows.map((r) => ({ ...r }));
  }

  async count(table: string): Promise<number> {
    if (!/^[a-z0-9_]+$/.test(table)) throw new Error(`Bad table name ${table}`);
    if (!(await this.tables()).includes(table)) return 0;
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM \`${table}\``,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}
