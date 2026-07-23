// Namespace import, not named: a runtime import of anything else in this barrel
// (e.g. web's `hasUsableFramePath` from culprit.ts) must not execute node:crypto
// just by being imported. Vite's browser build stubs node:crypto with a Proxy
// that throws on ANY property access — and named imports (`import { createHash }`)
// perform that property access immediately at module-evaluation time, even if
// the binding is never called. A namespace import defers property access to
// the actual call site inside a function, which apps/web never invokes.
import * as nodeCrypto from 'node:crypto';

/**
 * AES-256-GCM at-rest encryption for secrets (NFR-SEC-5): GitHub App secrets and
 * integration credentials (R2/SES). Shared so the API can encrypt and the
 * workers/ingest can decrypt with the same key. Key from APP_ENCRYPTION_KEY
 * (32-byte hex); in dev without one a fixed dev key is derived + a warning logged.
 *
 * Decrypt tries the configured key first, then falls back to the dev key — so
 * secrets encrypted on a service with APP_ENCRYPTION_KEY can be decrypted on a
 * service without it (and vice versa, as long as one side used the dev key).
 */
let warned = false;
let devKey: Buffer | null = null;
function getDevKey(): Buffer {
  if (!devKey) devKey = nodeCrypto.createHash('sha256').update('geniusdebug-dev-key').digest();
  return devKey;
}

function configuredKey(): Buffer | null {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  return null;
}

function key(): Buffer {
  const k = configuredKey();
  if (k) return k;
  if (!warned) {
    // eslint-disable-next-line no-console
    console.warn('[crypto] APP_ENCRYPTION_KEY not set — using a dev key. Set it in production.');
    warned = true;
  }
  return getDevKey();
}

export function encrypt(plain: string): string {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptWithKey(blob: string, k: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function decrypt(blob: string): string {
  const primary = key();
  try {
    return decryptWithKey(blob, primary);
  } catch {
    // Primary key failed — try dev key as fallback (handles cross-service key mismatch).
    const dev = getDevKey();
    if (primary.equals(dev)) throw new Error('decryption failed');
    return decryptWithKey(blob, dev);
  }
}
