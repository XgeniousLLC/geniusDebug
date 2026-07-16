import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for GitHub App secrets (NFR-SEC-5).
 * Key from APP_ENCRYPTION_KEY (32-byte hex). In dev without one, a key is derived
 * from a fixed string and a warning is logged — set a real key in production.
 */
function key(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  // eslint-disable-next-line no-console
  if (!key._warned) console.warn('[crypto] APP_ENCRYPTION_KEY not set — using a dev key. Set it in production.');
  key._warned = true;
  return createHash('sha256').update('geniusdebug-dev-key').digest();
}
key._warned = false as boolean;

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
