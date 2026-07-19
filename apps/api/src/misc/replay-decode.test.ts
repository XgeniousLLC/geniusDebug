import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { decodeReplayEvents } from './replay-decode';

const events = [
  { type: 4, data: { href: 'http://localhost:3000', width: 1280, height: 720 }, timestamp: 1 },
  { type: 2, data: { node: {} }, timestamp: 2 },
];
const json = Buffer.from(JSON.stringify(events));
const segHeader = Buffer.from('{"segment_id":7}\n');

test('zlib-deflated body with segment header (Sentry default)', () => {
  const blob = Buffer.concat([segHeader, deflateSync(json)]);
  assert.deepEqual(decodeReplayEvents(blob), events);
});

test('gzip-compressed body', () => {
  const blob = Buffer.concat([segHeader, gzipSync(json)]);
  assert.deepEqual(decodeReplayEvents(blob), events);
});

test('raw JSON array, no header', () => {
  assert.deepEqual(decodeReplayEvents(json), events);
});

test('{events:[...]} shape is unwrapped', () => {
  const blob = deflateSync(Buffer.from(JSON.stringify({ events })));
  assert.deepEqual(decodeReplayEvents(blob), events);
});

test('garbage → empty array (player falls back, never throws)', () => {
  assert.deepEqual(decodeReplayEvents(Buffer.from([0x00, 0x01, 0x02, 0x03])), []);
});
