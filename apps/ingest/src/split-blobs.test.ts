import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOversizedBlobs } from './split-blobs';

/** Without R2 configured, blobs stay inline (local fallback, FR-ING-4). */
test('no R2 → envelope unchanged, no blobs extracted', async () => {
  delete process.env.R2_ACCESS_KEY_ID; // ensure not configured
  const big = 'x'.repeat(300 * 1024);
  const env = Buffer.from(
    `${JSON.stringify({ event_id: 'e' })}\n${JSON.stringify({ type: 'replay_recording', length: big.length })}\n${big}\n`,
    'utf8',
  );
  const r = await splitOversizedBlobs(env, 'proj', 'e');
  assert.equal(r.blobs.length, 0);
  assert.equal(r.inline.equals(env), true);
});
