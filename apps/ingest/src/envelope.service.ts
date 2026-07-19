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

    // Envelope = header line, then repeating (item-header line, payload).
    // Byte-accurate framing walk: a `replay_recording`/`attachment` payload is
    // length-prefixed binary and CONTAINS `\n` bytes — splitting on `\n` mis-frames
    // it and rejects valid replays ("bad item header"). Honor the item-header
    // `length`; only scan headers + payload sizes, payloads stay opaque (FR-ING-3).
    const NL = 0x0a;
    const firstNl = bytes.indexOf(NL);
    if (firstNl < 0) return { ok: false, status: 400, reason: 'no envelope header', bytes };

    let eventId: string | undefined;
    try {
      const header = JSON.parse(bytes.subarray(0, firstNl).toString('utf8'));
      eventId = typeof header.event_id === 'string' ? header.event_id : undefined;
    } catch {
      return { ok: false, status: 400, reason: 'bad envelope header', bytes };
    }

    let offset = firstNl + 1;
    while (offset < bytes.length) {
      if (bytes[offset] === NL) {
        offset++;
        continue; // stray framing newline
      }
      const hNl = bytes.indexOf(NL, offset);
      const headerEnd = hNl < 0 ? bytes.length : hNl;
      let itemHeader: { type?: string; length?: number };
      try {
        itemHeader = JSON.parse(bytes.subarray(offset, headerEnd).toString('utf8'));
      } catch {
        return { ok: false, status: 400, reason: 'bad item header', bytes };
      }
      offset = headerEnd + 1;

      let payloadLen: number;
      if (typeof itemHeader.length === 'number') {
        payloadLen = itemHeader.length; // length-declared (binary-safe)
        offset += payloadLen;
        if (bytes[offset] === NL) offset++; // consume trailing framing newline
      } else {
        const pNl = bytes.indexOf(NL, offset); // newline-terminated payload
        const payloadEnd = pNl < 0 ? bytes.length : pNl;
        payloadLen = payloadEnd - offset;
        offset = payloadEnd + 1;
      }

      if ((itemHeader.type === 'event' || itemHeader.type === 'transaction') && payloadLen > MAX_EVENT_ITEM_BYTES) {
        return { ok: false, status: 413, reason: 'event item too large', bytes };
      }
    }

    return { ok: true, eventId, bytes };
  }
}
