/**
 * Photos and documents.
 *
 * Owners and staff send a picture as a data URL (what a phone camera or a
 * file input hands the app); the server checks its type and size, keeps the
 * bytes in object storage when one is configured (Amazon S3, Cloudflare R2,
 * Backblaze B2 — anything that speaks the S3 API) or in the database
 * otherwise, and stores only a short URL on the row. Files are served at
 * `/files/<key>`; the key is 256 random bits, like a pay link.
 */

import { createHash, createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ValidationError } from '@dawgs/core';
import { storedFiles, type Database } from '@dawgs/db';
import type { AppContext } from './context.js';
import { randomToken } from './crypto.js';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

const TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

export interface FileStore {
  readonly mode: 'database' | 's3';
  put(args: { key: string; businessId: string; type: string; bytes: Buffer; uploadedBy: string | null }): Promise<void>;
  get(key: string): Promise<{ type: string; bytes: Buffer } | null>;
}

export class DatabaseFiles implements FileStore {
  readonly mode = 'database' as const;
  constructor(private readonly db: Database) {}
  async put(a: { key: string; businessId: string; type: string; bytes: Buffer; uploadedBy: string | null }) {
    await this.db.insert(storedFiles).values({ key: a.key, businessId: a.businessId, contentType: a.type, size: a.bytes.length, data: a.bytes, uploadedBy: a.uploadedBy });
  }
  async get(key: string) {
    const [f] = await this.db.select().from(storedFiles).where(eq(storedFiles.key, key));
    return f?.data ? { type: f.contentType, bytes: f.data } : null;
  }
}

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Object storage through the S3 API, signed with AWS Signature V4 (path-style URLs, which R2 and S3 both accept). */
export class S3Files implements FileStore {
  readonly mode = 's3' as const;
  constructor(
    private readonly db: Database,
    private readonly cfg: S3Config,
  ) {}
  async put(a: { key: string; businessId: string; type: string; bytes: Buffer; uploadedBy: string | null }) {
    const res = await this.request('PUT', a.key, a.bytes, a.type);
    if (!res.ok) throw new Error(`storage answered ${res.status}`);
    await this.db.insert(storedFiles).values({ key: a.key, businessId: a.businessId, contentType: a.type, size: a.bytes.length, data: null, uploadedBy: a.uploadedBy });
  }
  async get(key: string) {
    const [f] = await this.db.select().from(storedFiles).where(eq(storedFiles.key, key));
    if (!f) return null;
    if (f.data) return { type: f.contentType, bytes: f.data };
    const res = await this.request('GET', key);
    if (!res.ok) return null;
    return { type: f.contentType, bytes: Buffer.from(await res.arrayBuffer()) };
  }

  private request(method: 'GET' | 'PUT', key: string, body?: Buffer, type?: string) {
    const url = new URL(`${this.cfg.endpoint.replace(/\/$/, '')}/${this.cfg.bucket}/${encodeURIComponent(key)}`);
    const headers = signV4({ method, url, body: body ?? Buffer.alloc(0), contentType: type, ...this.cfg, now: new Date() });
    return fetch(url, { method, headers, ...(body ? { body: new Uint8Array(body) } : {}), signal: AbortSignal.timeout(30_000) });
  }
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();

/** The headers for one S3 request, per AWS Signature Version 4. Exported for its test. */
export function signV4(a: {
  method: string;
  url: URL;
  body: Buffer;
  contentType?: string | undefined;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Record<string, string> {
  const amzDate = a.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(a.body);
  const headers: Record<string, string> = { host: a.url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (a.contentType) headers['content-type'] = a.contentType;
  const names = Object.keys(headers).sort();
  const canonical = [
    a.method,
    a.url.pathname,
    a.url.searchParams.toString(),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${a.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${a.secretAccessKey}`, day), a.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${a.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export function fileStoreFromEnv(db: Database, env: NodeJS.ProcessEnv): FileStore {
  const { DAWGS_S3_ENDPOINT, DAWGS_S3_BUCKET, DAWGS_S3_ACCESS_KEY_ID, DAWGS_S3_SECRET_ACCESS_KEY } = env;
  if (DAWGS_S3_ENDPOINT && DAWGS_S3_BUCKET && DAWGS_S3_ACCESS_KEY_ID && DAWGS_S3_SECRET_ACCESS_KEY) {
    return new S3Files(db, {
      endpoint: DAWGS_S3_ENDPOINT,
      bucket: DAWGS_S3_BUCKET,
      region: env.DAWGS_S3_REGION ?? 'auto',
      accessKeyId: DAWGS_S3_ACCESS_KEY_ID,
      secretAccessKey: DAWGS_S3_SECRET_ACCESS_KEY,
    });
  }
  return new DatabaseFiles(db);
}

/** Check and decode a data URL from an app. */
export function decodeDataUrl(dataUrl: string): { type: string; bytes: Buffer } {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)(;[^,]*)?,(.*)$/is.exec(dataUrl);
  if (!m) throw new ValidationError('that file could not be read');
  const type = m[1]!.toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1]!.toLowerCase();
  if (!TYPES[type]) throw new ValidationError('send a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  const bytes = /;base64/i.test(m[2] ?? '') ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
  if (!bytes.length) throw new ValidationError('that file is empty');
  if (bytes.length > MAX_FILE_BYTES) throw new ValidationError('that file is too big (8 MB at most)');
  return { type, bytes };
}

/** Keep a file and return the URL to store on the row. */
export async function saveFile(ctx: AppContext, args: { businessId: string; dataUrl: string; uploadedBy?: string | null }) {
  const { type, bytes } = decodeDataUrl(args.dataUrl);
  const key = `${randomToken()}.${TYPES[type]}`;
  await ctx.files.put({ key, businessId: args.businessId, type, bytes, uploadedBy: args.uploadedBy ?? null });
  return `${ctx.filesUrl.replace(/\/$/, '')}/files/${key}`;
}

/**
 * For fields that take a photo or document: a data URL is stored and swapped
 * for its URL; a link (or null/undefined) passes through unchanged.
 */
export async function keepUpload<T extends string | null | undefined>(ctx: AppContext, businessId: string, value: T, uploadedBy?: string | null): Promise<T | string> {
  if (typeof value === 'string' && value.startsWith('data:')) return saveFile(ctx, { businessId, dataUrl: value, uploadedBy: uploadedBy ?? null });
  return value;
}
