import { createHash } from 'node:crypto';
import type { NormalizedEvent } from '@geniusdebug/shared';

/** Strip volatile bits (numbers, hex ids, quotes) so "same bug" groups (FR-GRP-1). */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/0x[0-9a-f]+/gi, '0xHEX')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'HEX')
    .replace(/\d+/g, 'N')
    .replace(/['"]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Deterministic fingerprint (FR-GRP-1). Default: normalized top in-app frames
 * (module + function). Fallback: exception type + normalized message.
 * Honors a client-supplied fingerprint override (FR-GRP-6).
 */
export function computeFingerprint(e: NormalizedEvent): string {
  if (e.fingerprintOverride && e.fingerprintOverride.length > 0) {
    return sha(e.fingerprintOverride.join('|'));
  }

  const inApp = e.frames.filter((f) => f.inApp).slice(0, 5);
  const frameKey = inApp
    .map((f) => `${f.module ?? f.filename ?? ''}:${f.function ?? '?'}`)
    .join('>');

  if (frameKey) {
    return sha(`${e.exceptionType ?? ''}|${frameKey}`);
  }

  const msg = e.exceptionValue ?? e.message ?? '';
  return sha(`${e.exceptionType ?? ''}|${normalizeMessage(msg)}`);
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
