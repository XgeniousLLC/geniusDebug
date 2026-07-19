import type { ParsedEnvelope, RawEnvelopeItem, EnvelopeItemHeader } from '@geniusdebug/shared';

const NL = 0x0a; // '\n'

/**
 * Byte-accurate Sentry envelope parse — worker-side only (the hot path never
 * does this). Framing per the Sentry envelope spec:
 *   {envelope header}\n
 *   {item header}\n
 *   {payload}\n            (payload = exactly `length` bytes when the item
 *   {item header}\n         header declares one, else read to the next \n)
 *   ...
 *
 * Honoring the item header `length` is REQUIRED: `replay_recording` and
 * `attachment` payloads are binary/compressed and contain `\n` bytes. A naive
 * `text.split('\n')` corrupts them and then throws on `JSON.parse` of a mid-
 * payload line, which failed the whole job and silently dropped every replay.
 */
export function parseEnvelope(bytes: Buffer): ParsedEnvelope {
  let offset = 0;
  const nextNl = (from: number): number => {
    const idx = bytes.indexOf(NL, from);
    return idx === -1 ? bytes.length : idx;
  };

  // Envelope header (first line).
  let end = nextNl(offset);
  const header = JSON.parse(bytes.subarray(offset, end).toString('utf8'));
  offset = end + 1;

  const items: RawEnvelopeItem[] = [];
  while (offset < bytes.length) {
    // Skip stray blank framing lines.
    if (bytes[offset] === NL) {
      offset++;
      continue;
    }
    end = nextNl(offset);
    if (end <= offset) {
      offset = end + 1;
      continue;
    }
    const itemHeader = JSON.parse(bytes.subarray(offset, end).toString('utf8')) as EnvelopeItemHeader;
    offset = end + 1;

    let payload: Buffer;
    if (typeof itemHeader.length === 'number') {
      // Length-declared payload — read exactly N bytes (binary-safe). A length
      // that overruns the buffer means a truncated/malformed tail; stop rather
      // than emit a bogus item.
      if (itemHeader.length < 0 || offset + itemHeader.length > bytes.length) break;
      payload = bytes.subarray(offset, offset + itemHeader.length);
      offset += itemHeader.length;
      if (bytes[offset] === NL) offset++; // consume the trailing framing newline
    } else {
      // Newline-terminated payload (JSON items).
      const pend = nextNl(offset);
      payload = bytes.subarray(offset, pend);
      offset = pend + 1;
    }
    items.push({ header: itemHeader, payload });
  }

  return { header, items };
}
