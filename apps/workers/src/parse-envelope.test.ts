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
