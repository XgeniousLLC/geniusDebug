/**
 * R2 client for the ingest hot path — used ONLY to stream oversized blob items
 * (replay_recording/attachment) straight to R2 so they never sit in the queue
 * (FR-ING-4/FR-RPL-2). No-op when R2 isn't configured (local dev keeps items
 * inline). Config resolves from env (ops override) first, else the DB
 * `integrations` row saved via the dashboard. The DB lookup only runs on the
 * already-heavy oversized-blob path (never the common enqueue path) and is
 * cached, so the hot path stays cheap (FR-ING-3). Server-side creds only.
 */
import { getActiveIntegration } from '@geniusdebug/db';
import { decrypt } from '@geniusdebug/shared';

interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const TTL_MS = 30_000;
let cache: { cfg: R2Config | null; at: number } | null = null;
const clients = new Map<string, Promise<any>>();

function fromEnv(): R2Config | null {
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET } = process.env;
  if (R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT && R2_BUCKET) {
    return { endpoint: R2_ENDPOINT, bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY };
  }
  return null;
}

async function resolveConfig(): Promise<R2Config | null> {
  const env = fromEnv();
  if (env) return env;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  let cfg: R2Config | null = null;
  try {
    const row = await getActiveIntegration('r2');
    if (row?.secretEnc) {
      const sec = JSON.parse(decrypt(row.secretEnc)) as { accessKeyId?: string; secretAccessKey?: string };
      const c = row.config as { endpoint?: string; bucket?: string };
      if (c.endpoint && c.bucket && sec.accessKeyId && sec.secretAccessKey) {
        cfg = { endpoint: c.endpoint, bucket: c.bucket, accessKeyId: sec.accessKeyId, secretAccessKey: sec.secretAccessKey };
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[ingest] R2 config resolution failed — if R2 is set in Integrations, ensure APP_ENCRYPTION_KEY matches across all services, or set R2 env vars (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET) on ingest.', e instanceof Error ? e.message : e);
    cfg = null;
  }
  cache = { cfg, at: Date.now() };
  return cfg;
}

export async function r2Configured(): Promise<boolean> {
  return (await resolveConfig()) !== null;
}

async function client(cfg: R2Config) {
  const fp = `${cfg.endpoint}|${cfg.accessKeyId}`;
  let p = clients.get(fp);
  if (!p) {
    p = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        region: 'auto',
        endpoint: cfg.endpoint,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      });
    })();
    clients.set(fp, p);
  }
  return p;
}

export async function putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<boolean> {
  const cfg = await resolveConfig();
  if (!cfg) return false;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client(cfg);
  await c.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }));
  return true;
}
