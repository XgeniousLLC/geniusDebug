import { inflateSync, gunzipSync } from 'node:zlib';

/**
 * Decode a Sentry `replay_recording` blob → rrweb event array (FR-RPL). The stored
 * payload is an optional `{"segment_id":N}\n` JSON header line followed by the
 * rrweb body, which the SDK may zlib-deflate, gzip, or send as raw JSON. Try each
 * codec and shape; return [] if nothing decodes (player falls back to a notice).
 */
export function decodeReplayEvents(blob: Buffer): unknown[] {
  // Strip a leading segment-header JSON line if present.
  let body = blob;
  const nl = blob.indexOf(0x0a);
  if (nl > 0 && (blob[0] === 0x7b || blob[0] === 0x5b)) {
    const head = blob.subarray(0, nl).toString('utf8').trim();
    if (/^\{.*\}$/.test(head) && head.includes('segment_id')) body = blob.subarray(nl + 1);
  }

  const codecs: Array<() => Buffer> = [];
  if (body[0] === 0x1f && body[1] === 0x8b) codecs.push(() => gunzipSync(body)); // gzip magic
  if (body[0] === 0x78) codecs.push(() => inflateSync(body)); // zlib magic
  codecs.push(() => body); // raw JSON
  codecs.push(() => inflateSync(body), () => gunzipSync(body)); // last-ditch, either way

  for (const run of codecs) {
    try {
      const parsed = JSON.parse(run().toString('utf8'));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray((parsed as { events?: unknown[] }).events)) return (parsed as { events: unknown[] }).events;
    } catch {
      /* try next codec */
    }
  }
  return [];
}
