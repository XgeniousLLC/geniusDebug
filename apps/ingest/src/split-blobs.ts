import { putObject, r2Configured } from './r2';

const STREAM_THRESHOLD = Number(process.env.BLOB_STREAM_THRESHOLD ?? 200 * 1024); // 200 KiB

export interface BlobPointer {
  type: string; // replay_recording | attachment
  r2Key: string;
  size: number;
  filename?: string;
}

export interface SplitResult {
  /** Envelope bytes with oversized blob items removed (small items kept inline). */
  inline: Buffer;
  /** Pointers to the blobs streamed to R2. */
  blobs: BlobPointer[];
}

const NL = 0x0a; // '\n'

/**
 * Stream blob items straight to R2 and enqueue only a pointer (FR-ING-4/FR-RPL-2)
 * — the blob never sits in the queue.
 *
 * Policy: **every `replay_recording`** goes to R2 (any size) so replay DOM
 * playback has the rrweb blob (FR-RPL); `attachment` goes to R2 only when
 * oversized. Falls back to leaving items inline when R2 isn't configured (local
 * dev), so behavior is unchanged there.
 *
 * Byte-accurate framing: item payloads are length-prefixed binary (compressed
 * rrweb contains `\n`). We honor the item-header `length` and store the RAW
 * payload bytes — a `\n` split + utf8 re-encode corrupted the blob and the inline
 * envelope.
 */
export async function splitOversizedBlobs(bytes: Buffer, projectId: string, eventId?: string): Promise<SplitResult> {
  if (!(await r2Configured())) return { inline: bytes, blobs: [] };

  const firstNl = bytes.indexOf(NL);
  if (firstNl < 0) return { inline: bytes, blobs: [] };

  const headerLine = bytes.subarray(0, firstNl); // envelope header (raw)
  const kept: Buffer[] = []; // raw item chunks (header\n + payload\n) kept inline
  const blobs: BlobPointer[] = [];
  let idx = 0;
  let offset = firstNl + 1;

  while (offset < bytes.length) {
    if (bytes[offset] === NL) {
      offset++;
      continue; // stray framing newline
    }
    const hNl = bytes.indexOf(NL, offset);
    const headerEnd = hNl < 0 ? bytes.length : hNl;
    let header: { type?: string; length?: number; filename?: string };
    try {
      header = JSON.parse(bytes.subarray(offset, headerEnd).toString('utf8'));
    } catch {
      kept.push(bytes.subarray(offset, headerEnd + 1)); // leave unparsable line untouched
      offset = headerEnd + 1;
      continue;
    }

    const payloadStart = headerEnd + 1;
    const payloadEnd =
      typeof header.length === 'number'
        ? payloadStart + header.length
        : (() => {
            const pNl = bytes.indexOf(NL, payloadStart);
            return pNl < 0 ? bytes.length : pNl;
          })();
    const payload = bytes.subarray(payloadStart, payloadEnd);
    let next = payloadEnd;
    if (bytes[next] === NL) next++; // consume trailing framing newline

    const size = header.length ?? payload.length;
    const toR2 =
      header.type === 'replay_recording' || (header.type === 'attachment' && size > STREAM_THRESHOLD);

    if (toR2) {
      const r2Key = `blobs/${projectId}/${eventId ?? 'e'}/${idx}-${header.type}`;
      await putObject(r2Key, payload); // raw bytes — binary-safe
      blobs.push({ type: header.type!, r2Key, size, filename: header.filename });
      idx++;
      // Drop the item from the inline envelope (pointer travels on the job).
    } else {
      kept.push(bytes.subarray(offset, next)); // raw header\n + payload\n
    }
    offset = next;
  }

  if (blobs.length === 0) return { inline: bytes, blobs: [] };
  const inline = Buffer.concat([headerLine, Buffer.from('\n'), ...kept]);
  return { inline, blobs };
}
