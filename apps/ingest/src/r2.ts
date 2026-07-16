/**
 * R2 client for the ingest hot path — used ONLY to stream oversized blob items
 * (replay_recording/attachment) straight to R2 so they never sit in the queue
 * (FR-ING-4/FR-RPL-2). No-op when R2 isn't configured (local dev keeps items
 * inline). Server-side creds only (NFR-SEC-5).
 */
let clientPromise: Promise<any> | null = null;

export function r2Configured(): boolean {
  return !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT && process.env.R2_BUCKET);
}

async function client() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      return new S3Client({
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
      });
    })();
  }
  return clientPromise;
}

export async function putObject(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<boolean> {
  if (!r2Configured()) return false;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const c = await client();
  await c.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return true;
}
