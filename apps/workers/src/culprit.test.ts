import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCulprit } from '@geniusdebug/shared';
import type { NormalizedFrame } from '@geniusdebug/shared';

const f = (over: Partial<NormalizedFrame>): NormalizedFrame => ({ inApp: false, ...over });

test('picks the top in-app frame with a real path (FR-GRP-3)', () => {
  const frames = [
    f({ absPath: 'vendor/laravel/framework/src/Foo.php', inApp: false }),
    f({ absPath: 'app/Jobs/SyncMailbox.php', inApp: true }),
  ];
  assert.equal(computeCulprit(frames), 'app/Jobs/SyncMailbox.php');
});

test('skips a frame whose file the SDK could not resolve ("Unknown" placeholder)', () => {
  // sentry-php shutdown-captured fatal: the only in_app frame has no real file.
  const frames = [
    f({ absPath: 'vendor/laravel/framework/src/Illuminate/Foundation/Bootstrap/HandleExceptions.php', inApp: false }),
    f({ absPath: 'Unknown', function: 'HandleExceptions::handleError', inApp: true }),
  ];
  assert.equal(
    computeCulprit(frames),
    'vendor/laravel/framework/src/Illuminate/Foundation/Bootstrap/HandleExceptions.php',
    'falls through to the nearest frame with a real path instead of showing the literal string "Unknown"',
  );
});

test('all frames unusable → falls back to the previous culprit', () => {
  const frames = [f({ absPath: 'Unknown', inApp: true }), f({ filename: '[internal]', inApp: false })];
  assert.equal(computeCulprit(frames, 'app/Jobs/SyncMailbox.php'), 'app/Jobs/SyncMailbox.php');
});

test('no frames at all and no previous culprit → undefined, not a crash', () => {
  assert.equal(computeCulprit([]), undefined);
});

test('framework-only stack: transaction beats the node_modules frame path (Sentry-style headline)', () => {
  const frames = [
    f({ absPath: 'node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js', inApp: false }),
  ];
  assert.equal(computeCulprit(frames, undefined, '/login'), '/login');
});

test('in-app frame still beats the transaction', () => {
  const frames = [
    f({ absPath: 'node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js', inApp: false }),
    f({ absPath: 'app/sentry-replay-test/page.tsx', inApp: true }),
  ];
  assert.equal(computeCulprit(frames, undefined, '/sentry-replay-test'), 'app/sentry-replay-test/page.tsx');
});

test('no transaction → framework frame path still shown (better than nothing)', () => {
  const frames = [
    f({ absPath: 'node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js', inApp: false }),
  ];
  assert.equal(
    computeCulprit(frames),
    'node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js',
  );
});
