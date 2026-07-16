/**
 * Cloudflare R2 (S3-compatible) client — server-side only (NFR-SEC-4/5).
 * No-ops gracefully when creds are absent so local dev never breaks; activates
 * for real map fetch (FR-MAP-3) and retention deletes (FR-MAP-9) once configured.
 */
let clientPromise: Promise<any> | null = null;

export function r2Configured(): boolean {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET);
}

async function client() {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Dynamic import so @aws-sdk is only loaded when R2 is actually configured.
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      });
    })();
  }
  return clientPromise;
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (!r2Configured()) return null;
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  const res = await c.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function deleteObjects(keys: string[]): Promise<number> {
  if (!r2Configured() || keys.length === 0) return 0;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  for (const Key of keys) await c.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key }));
  return keys.length;
}
