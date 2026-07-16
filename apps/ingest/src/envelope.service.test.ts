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

test('rejects bad gzip → 400', () => {
  const r = svc.shallowValidate(Buffer.from([0x1f, 0x8b, 0x00, 0x01]), 'gzip');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});
