import type { ParsedEnvelope, RawEnvelopeItem } from '@geniusdebug/shared';

/**
 * Full envelope parse — worker-side only (the hot path never does this).
 * Splits the newline-delimited framing into header + typed items.
 */
export function parseEnvelope(bytes: Buffer): ParsedEnvelope {
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const header = JSON.parse(lines[0]);
  const items: RawEnvelopeItem[] = [];
  let i = 1;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++;
      continue;
    }
    const itemHeader = JSON.parse(lines[i]);
    const payloadLine = lines[i + 1] ?? '';
    items.push({ header: itemHeader, payload: Buffer.from(payloadLine, 'utf8') });
    i += 2;
  }
  return { header, items };
}
