import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComponentStack } from './normalize';

test('parses a production React componentStack into frames (innermost stored last)', () => {
  const cs = [
    '',
    '    at kb (https://crm.example.com/_next/static/chunks/3dcawd6bioshu.js:1:2747)',
    '    at div',
    '    at Yh (https://crm.example.com/_next/static/chunks/38zo_k9mrj9dv.js:13:245119)',
  ].join('\n');
  const frames = parseComponentStack(cs)!;
  assert.equal(frames.length, 3);
  // innermost (kb — the mismatching component) must be LAST (NormalizedFrame order)
  const innermost = frames[frames.length - 1];
  assert.equal(innermost.function, 'kb');
  assert.equal(innermost.absPath, 'https://crm.example.com/_next/static/chunks/3dcawd6bioshu.js');
  assert.equal(innermost.lineno, 1);
  assert.equal(innermost.colno, 2747);
  // host component without location keeps its name, no path
  const div = frames[1];
  assert.equal(div.function, 'div');
  assert.equal(div.absPath, undefined);
});

test('returns undefined for empty/garbage input', () => {
  assert.equal(parseComponentStack(''), undefined);
  assert.equal(parseComponentStack('not a stack'), undefined);
});
