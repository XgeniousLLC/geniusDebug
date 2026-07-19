import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitOversizedBlobs, type SplitDeps } from './split-blobs';

/** Fake R2 that records what was streamed, so we can assert extraction. */
function fakeR2() {
  const puts: { key: string; body: Buffer }[] = [];
  const deps: SplitDeps = {
    configured: async () => true,
    put: async (key, body) => {
      puts.push({ key, body });
    },
  };
  return { deps, puts };
}

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

test('R2 configured → every replay_recording streamed, raw binary preserved, dropped from inline', async () => {
  const { deps, puts } = fakeR2();
  // rrweb payload is small (< threshold) AND binary (contains \n) — must still
  // go to R2 with exact bytes (regression: was inline / utf8-corrupted).
  const rec = Buffer.concat([Buffer.from('{"segment_id":0}\n'), Buffer.from([0x78, 0x9c, 0x0a, 0x00, 0xff])]);
  const env = Buffer.concat([
    Buffer.from(JSON.stringify({ event_id: 'e1' }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_event' }) + '\n'),
    Buffer.from(JSON.stringify({ seg: 0 }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_recording', length: rec.length }) + '\n'),
    rec,
    Buffer.from('\n'),
  ]);
  const r = await splitOversizedBlobs(env, 'proj', 'e1', deps);
  assert.equal(r.blobs.length, 1);
  assert.equal(r.blobs[0].type, 'replay_recording');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body.equals(rec), true); // exact raw bytes
  // replay_event stays inline; recording removed.
  assert.equal(r.inline.includes('replay_event'), true);
  assert.equal(r.inline.includes('replay_recording'), false);
});
