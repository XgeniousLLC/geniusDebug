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

/**
 * Stream oversized replay_recording/attachment items straight to R2 and enqueue
 * only a pointer (FR-ING-4/FR-RPL-2) — the big blob never sits in the queue.
 * Falls back to leaving items inline when R2 isn't configured (local dev) or when
 * there are no oversized blobs, so behavior is unchanged in that case.
 */
export async function splitOversizedBlobs(bytes: Buffer, projectId: string, eventId?: string): Promise<SplitResult> {
  if (!r2Configured()) return { inline: bytes, blobs: [] };

  const text = bytes.toString('utf8');
  const nl = text.indexOf('\n');
  if (nl < 0) return { inline: bytes, blobs: [] };

  const headerLine = text.slice(0, nl);
  const lines = text.slice(nl + 1).split('\n');
  const kept: string[] = [];
  const blobs: BlobPointer[] = [];
  let idx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let header: { type?: string; length?: number; filename?: string };
    try {
      header = JSON.parse(line);
    } catch {
      kept.push(line); // leave anything we can't parse untouched
      continue;
    }
    const payload = lines[i + 1] ?? '';
    i++; // consume payload line
    const size = header.length ?? Buffer.byteLength(payload, 'utf8');
    const isBlob = header.type === 'replay_recording' || header.type === 'attachment';

    if (isBlob && size > STREAM_THRESHOLD) {
      const r2Key = `blobs/${projectId}/${eventId ?? 'e'}/${idx}-${header.type}`;
      await putObject(r2Key, Buffer.from(payload, 'utf8'));
      blobs.push({ type: header.type!, r2Key, size, filename: header.filename });
      idx++;
      // Drop the item from the inline envelope (pointer travels on the job).
    } else {
      kept.push(line, payload);
    }
  }

  if (blobs.length === 0) return { inline: bytes, blobs: [] };
  const inline = Buffer.from(`${headerLine}\n${kept.join('\n')}\n`, 'utf8');
  return { inline, blobs };
}
