import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from './parse-envelope';

test('parses header + typed items from newline framing', () => {
  const bytes = Buffer.from(
    [
      JSON.stringify({ event_id: 'abc', sdk: { name: 's' } }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ level: 'error' }),
      JSON.stringify({ type: 'transaction' }),
      JSON.stringify({ spans: [] }),
      '',
    ].join('\n'),
    'utf8',
  );
  const env = parseEnvelope(bytes);
  assert.equal(env.header.event_id, 'abc');
  assert.equal(env.items.length, 2);
  assert.equal(env.items[0].header.type, 'event');
  assert.equal(env.items[1].header.type, 'transaction');
});

test('length-prefixed replay_recording with embedded newlines parses intact', () => {
  // rrweb payloads are binary/compressed and contain \n bytes — must be read by
  // the item header `length`, not split on \n (regression: replays were dropped).
  const rec = Buffer.from('rrweb\nbinary\x00data\nwith newlines');
  const parts: Buffer[] = [
    Buffer.from(JSON.stringify({ event_id: 'r1' }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_event' }) + '\n'),
    Buffer.from(JSON.stringify({ segment_id: 0 }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_recording', length: rec.length }) + '\n'),
    rec,
    Buffer.from('\n'),
  ];
  const env = parseEnvelope(Buffer.concat(parts));
  assert.equal(env.items.length, 2);
  assert.equal(env.items[0].header.type, 'replay_event');
  assert.equal(env.items[1].header.type, 'replay_recording');
  assert.equal(env.items[1].payload.length, rec.length);
  assert.equal(env.items[1].payload.toString(), rec.toString());
});
