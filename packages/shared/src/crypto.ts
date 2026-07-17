import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for secrets (NFR-SEC-5): GitHub App secrets and
 * integration credentials (R2/SES). Shared so the API can encrypt and the
 * workers/ingest can decrypt with the same key. Key from APP_ENCRYPTION_KEY
 * (32-byte hex); in dev without one a fixed dev key is derived + a warning logged.
 */
let warned = false;
function key(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  if (!warned) {
    // eslint-disable-next-line no-console
    console.warn('[crypto] APP_ENCRYPTION_KEY not set — using a dev key. Set it in production.');
    warned = true;
  }
  return createHash('sha256').update('geniusdebug-dev-key').digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
