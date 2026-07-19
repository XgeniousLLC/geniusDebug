import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnifiedDiff } from './apply-diff';

const original = ['function f(x) {', '  return x.value;', '}', ''].join('\n');

test('applies a clean single-hunk patch', () => {
  const diff = [
    '--- a/f.js',
    '+++ b/f.js',
    '@@ -1,3 +1,3 @@',
    ' function f(x) {',
    '-  return x.value;',
    '+  return x?.value;',
    ' }',
  ].join('\n');
  const out = applyUnifiedDiff(original, diff);
  assert.equal(out, ['function f(x) {', '  return x?.value;', '}', ''].join('\n'));
});

test('adds a line', () => {
  const diff = ['@@ -1,2 +1,3 @@', ' function f(x) {', '+  if (!x) return null;', '   return x.value;'].join('\n');
  const out = applyUnifiedDiff(original, diff);
  assert.match(out, /if \(!x\) return null;/);
});

test('throws on context drift (patch no longer applies)', () => {
  const diff = ['@@ -1,3 +1,3 @@', ' function g(y) {', '-  return y.value;', '+  return y?.value;', ' }'].join('\n');
  assert.throws(() => applyUnifiedDiff(original, diff), /context mismatch/);
});

test('throws when there are no hunks', () => {
  assert.throws(() => applyUnifiedDiff(original, 'just some text'), /no hunks/);
});
