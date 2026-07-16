import { Injectable } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';

const MAX_EVENT_ITEM_BYTES = Number(process.env.MAX_EVENT_ITEM_BYTES ?? 1_048_576);
const MAX_ENVELOPE_BYTES = Number(process.env.MAX_ENVELOPE_BYTES ?? 209_715_200);

export interface ShallowResult {
  ok: boolean;
  status?: number; // set when !ok
  reason?: string;
  eventId?: string;
  bytes: Buffer; // decompressed envelope
}

/**
 * Shallow envelope validation ONLY (FR-ING-3): decompress, verify header + item
 * framing, enforce size caps. It does NOT parse payloads (no symbolication /
 * grouping / DB writes) — that is worker work. Target p95 < 25 ms (NFR-PERF-6).
 */
@Injectable()
export class EnvelopeService {
  shallowValidate(raw: Buffer, contentEncoding?: string): ShallowResult {
    let bytes = raw;
    try {
      if (contentEncoding && /gzip/i.test(contentEncoding)) bytes = gunzipSync(raw);
    } catch {
      return { ok: false, status: 400, reason: 'bad gzip', bytes: raw };
    }

    if (bytes.length > MAX_ENVELOPE_BYTES) {
      return { ok: false, status: 413, reason: 'envelope too large', bytes };
    }

    // Envelope = header line, then repeating (item-header line, payload line).
    // We only scan header lines + payload lengths; payloads stay opaque.
    const text = bytes.toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) return { ok: false, status: 400, reason: 'no envelope header', bytes };

    let eventId: string | undefined;
    try {
      const header = JSON.parse(text.slice(0, nl));
      eventId = typeof header.event_id === 'string' ? header.event_id : undefined;
    } catch {
      return { ok: false, status: 400, reason: 'bad envelope header', bytes };
    }

    // Walk item headers to enforce per-event-item caps (framing check only).
    const lines = text.slice(nl + 1).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      let itemHeader: { type?: string; length?: number };
      try {
        itemHeader = JSON.parse(line);
      } catch {
        return { ok: false, status: 400, reason: 'bad item header', bytes };
      }
      const payload = lines[i + 1] ?? '';
      const declared = typeof itemHeader.length === 'number' ? itemHeader.length : Buffer.byteLength(payload, 'utf8');
      if ((itemHeader.type === 'event' || itemHeader.type === 'transaction') && declared > MAX_EVENT_ITEM_BYTES) {
        return { ok: false, status: 413, reason: 'event item too large', bytes };
      }
      i++; // skip the payload line
    }

    return { ok: true, eventId, bytes };
  }
}
