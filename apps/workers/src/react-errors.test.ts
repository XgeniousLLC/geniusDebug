import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeReactError } from './react-errors';

test('decodes minified React error #418 into the real hydration message, substituting args[]', () => {
  const out = decodeReactError(
    "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
  );
  assert.ok(out, 'decoded');
  assert.ok(out.startsWith('React error #418:'), 'keeps the code for searchability');
  assert.ok(out.includes('Hydration failed because the server rendered HTML'), 'args[] substituted into %s');
  assert.ok(!out.includes('%s'), 'no unfilled placeholders');
});

test('decodes a code with no args', () => {
  const out = decodeReactError('Minified React error #423; visit https://react.dev/errors/423 for the full message');
  assert.ok(out?.includes('error while hydrating but React was able to recover'));
});

test('returns undefined for non-React messages and unknown codes (caller keeps original)', () => {
  assert.equal(decodeReactError('Cannot read properties of undefined'), undefined);
  assert.equal(decodeReactError('Minified React error #999999; visit x'), undefined);
});
