import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

/**
 * Private file storage behind one interface (D102, docs/17 §5): the local disk (default, dev and
 * tests) or any S3-compatible store (DigitalOcean Spaces) with `STORAGE_DRIVER=s3`. Files are never
 * public: the API streams them after its policy check, or (S3 only) hands out a short-lived signed
 * link (`signedUrl`), which a mobile client can download directly.
 */
export abstract class FileStorage {
  abstract readonly driver: 'local' | 's3';
  abstract put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  /** null when the file is missing. */
  abstract get(key: string): Promise<Buffer | null>;
  abstract delete(key: string): Promise<void>;
  /** A temporary download link, or null when the driver has none (stream through the API). */
  abstract signedUrl(key: string, ttlSeconds?: number): string | null;
}

const KEY = /^[A-Za-z0-9/_.-]+$/;

export function assertKey(key: string): void {
  if (!KEY.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error('Invalid storage key.');
  }
}

/** Files under `STORAGE_LOCAL_DIR`; a key can never leave that folder. */
export class LocalDiskStorage extends FileStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key.');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  signedUrl(): null {
    return null;
  }
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  signedUrlTtl: number;
}

type Fetch = typeof fetch;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as AWS wants it (`/` kept in paths). */
const enc = (s: string, keepSlash = false) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');

/**
 * S3-compatible store (path-style URLs: `<endpoint>/<bucket>/<key>`), AWS Signature V4 by hand
 * (no SDK). Objects are private; downloads go through `signedUrl` (query-signed GET).
 */
export class S3Storage extends FileStorage {
  readonly driver = 's3' as const;

  constructor(
    private readonly cfg: S3Config,
    private readonly http: Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    super();
  }

  private target(key: string): { url: URL; path: string } {
    assertKey(key);
    const base = new URL(this.cfg.endpoint);
    const path = `/${enc(this.cfg.bucket)}/${enc(key, true)}`;
    return { url: new URL(path, base), path };
  }

  private scope(date: Date) {
    const amzDate = date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    return { amzDate, day, scope: `${day}/${this.cfg.region}/s3/aws4_request` };
  }

  private signature(day: string, stringToSign: string): string {
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, day);
    const kRegion = hmac(kDate, this.cfg.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    return createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  }

  /** Header-signed request (PUT / GET / DELETE). */
  private async send(method: string, key: string, body?: Buffer, contentType?: string) {
    const { url, path } = this.target(key);
    const { amzDate, day, scope } = this.scope(this.now());
    const payloadHash = sha256(body ?? '');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      '',
      ...names.map((n) => `${n}:${headers[n]}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const auth =
      `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(';')}, Signature=${this.signature(day, toSign)}`;
    // `host` is signed but set by fetch itself from the URL.
    const sent = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host'));
    return this.http(url, {
      method,
      headers: { ...sent, authorization: auth },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  async put(key: string, bytes: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.send('PUT', key, bytes, contentType);
    if (!res.ok) throw new Error(`Storage PUT failed (${res.status}).`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage GET failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`Storage DELETE failed (${res.status}).`);
  }

  /** Query-signed GET valid for `ttlSeconds` (default `S3_SIGNED_URL_TTL`). */
  signedUrl(key: string, ttlSeconds = this.cfg.signedUrlTtl): string {
    const { url, path } = this.target(key);
    const { amzDate, day, scope } = this.scope(this.now());
    const params: Array<[string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.cfg.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(ttlSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    const query = params
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .sort()
      .join('&');
    const canonical = ['GET', path, query, `host:${url.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join(
      '\n',
    );
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    return `${url.origin}${path}?${query}&X-Amz-Signature=${this.signature(day, toSign)}`;
  }
}

/** The configured driver (`STORAGE_DRIVER`). */
export function storageFromEnv(env: Env): FileStorage {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      endpoint: env.S3_ENDPOINT!,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET!,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      signedUrlTtl: env.S3_SIGNED_URL_TTL,
    });
  }
  return new LocalDiskStorage(env.STORAGE_LOCAL_DIR);
}

@Global()
@Module({
  providers: [{ provide: FileStorage, useFactory: storageFromEnv, inject: [ENV] }],
  exports: [FileStorage],
})
export class StorageModule {}
