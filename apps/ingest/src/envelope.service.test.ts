import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { EnvelopeService } from './envelope.service';

const svc = new EnvelopeService();

function envelope(items: [object, object][], header: object = { event_id: 'a'.repeat(32) }): Buffer {
  const lines = [JSON.stringify(header)];
  for (const [h, p] of items) lines.push(JSON.stringify(h), JSON.stringify(p));
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

test('accepts a well-formed event envelope (FR-ING-3)', () => {
  const r = svc.shallowValidate(envelope([[{ type: 'event' }, { level: 'error' }]]));
  assert.equal(r.ok, true);
  assert.equal(r.eventId, 'a'.repeat(32));
});

test('gunzips gzip-encoded envelopes (FR-ING-3)', () => {
  const raw = envelope([[{ type: 'event' }, { level: 'error' }]]);
  const r = svc.shallowValidate(gzipSync(raw), 'gzip');
  assert.equal(r.ok, true);
});

test('rejects missing envelope header → 400', () => {
  const r = svc.shallowValidate(Buffer.from('not-an-envelope', 'utf8'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('rejects oversized event item → 413 (FR-ING-4)', () => {
  const r = svc.shallowValidate(envelope([[{ type: 'event', length: 2_000_000 }, { big: true }]]));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('accepts a replay envelope with length-prefixed binary recording (FR-RPL-2)', () => {
  // rrweb recording payload is binary/compressed and contains \n bytes; framing
  // must be read by the item `length`, not split on \n (was rejected 400).
  const rec = Buffer.concat([Buffer.from('{"segment_id":7}\n'), Buffer.from([0x78, 0x9c, 0x0a, 0x00, 0xff, 0x0a, 0x1f])]);
  const bytes = Buffer.concat([
    Buffer.from(JSON.stringify({ event_id: 'b'.repeat(32) }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_event' }) + '\n'),
    Buffer.from(JSON.stringify({ replay_id: 'b'.repeat(32) }) + '\n'),
    Buffer.from(JSON.stringify({ type: 'replay_recording', length: rec.length }) + '\n'),
    rec,
    Buffer.from('\n'),
  ]);
  const r = svc.shallowValidate(bytes);
  assert.equal(r.ok, true);
  assert.equal(r.eventId, 'b'.repeat(32));
});

test('rejects bad gzip → 400', () => {
  const r = svc.shallowValidate(Buffer.from([0x1f, 0x8b, 0x00, 0x01]), 'gzip');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});
