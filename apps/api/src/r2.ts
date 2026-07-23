/**
 * Cloudflare R2 (S3-compatible) read client for the API — server-side only
 * (NFR-SEC-4/5). Config resolves from env (ops override) first, else the DB
 * `integrations` row saved via the dashboard (secret AES-GCM decrypted here).
 * Used to serve replay recording blobs to the player (FR-RPL). No-ops when
 * unconfigured so local dev never breaks.
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
  } catch {
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

export async function getObject(key: string): Promise<Buffer | null> {
  const cfg = await resolveConfig();
  if (!cfg) return null;
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client(cfg);
  try {
    const res = await c.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch {
    return null; // missing object / access error → treat as no blob
  }
}

/** Best-effort blob cleanup for issue/replay delete (mirrors workers/src/r2.ts). */
export async function deleteObjects(keys: string[]): Promise<number> {
  const cfg = await resolveConfig();
  if (!cfg || keys.length === 0) return 0;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client(cfg);
  for (const Key of keys) {
    try {
      await c.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }));
    } catch {
      // missing object / access error — nothing more we can do here
    }
  }
  return keys.length;
}
