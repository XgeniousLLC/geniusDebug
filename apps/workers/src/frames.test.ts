import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFramePath, pickSuspectFrame } from '@geniusdebug/shared';
import type { NormalizedFrame } from '@geniusdebug/shared';

const f = (over: Partial<NormalizedFrame>): NormalizedFrame => ({ inApp: false, ...over });

test('normalizeFramePath strips webpack-internal (Next.js dev) prefix', () => {
  assert.equal(normalizeFramePath('webpack-internal:///(app-pages-browser)/./app/page.tsx'), 'app/page.tsx');
});

test('normalizeFramePath strips webpack://_N_E/ prefix', () => {
  assert.equal(normalizeFramePath('webpack://_N_E/app/page.tsx'), 'app/page.tsx');
});

test('normalizeFramePath strips bare webpack:// prefix', () => {
  assert.equal(normalizeFramePath('webpack://app/page.tsx'), 'app/page.tsx');
});

test('normalizeFramePath strips turbopack:///[project]/ prefix', () => {
  assert.equal(normalizeFramePath('turbopack:///[project]/app/sentry-replay-test/page.tsx'), 'app/sentry-replay-test/page.tsx');
});

test('normalizeFramePath strips a built _next/(app|src)/ asset prefix, with or without an origin', () => {
  assert.equal(normalizeFramePath('_next/app/page.js'), 'app/page.js');
  assert.equal(normalizeFramePath('https://example.com/_next/src/client.js'), 'src/client.js');
});

test('normalizeFramePath strips a leading ./', () => {
  assert.equal(normalizeFramePath('./app/page.tsx'), 'app/page.tsx');
});

test('normalizeFramePath returns undefined for empty/undefined/null input', () => {
  assert.equal(normalizeFramePath(undefined), undefined);
  assert.equal(normalizeFramePath(null), undefined);
  assert.equal(normalizeFramePath(''), undefined);
});

test('pickSuspectFrame prefers an in-app frame with source context over anything else', () => {
  const frames = [
    f({ filename: 'app/page.tsx', inApp: true, contextLine: 'throw new Error()' }),
    f({ filename: 'node_modules/next/dist/client/app-bootstrap.js', inApp: false, contextLine: 'dispatch()' }),
  ];
  assert.equal(pickSuspectFrame(frames)?.filename, 'app/page.tsx');
});

test('regression: in-app frame without context must NOT lose to a framework frame that resolved WITH context', () => {
  // A frame can be inApp:true with contextLine:undefined (its own chunk's map
  // lacked sourcesContent) while an unrelated framework frame from a
  // different chunk resolved with full context — the in-app frame must still
  // win, since showing the wrong (framework) frame is worse than showing the
  // right frame with no code snippet.
  const frames = [
    f({ filename: 'app/sentry-replay-test/page.tsx', inApp: true, contextLine: undefined }),
    f({ filename: 'node_modules/next/src/client/app-bootstrap.ts', inApp: false, contextLine: 'const root = document;' }),
  ];
  assert.equal(pickSuspectFrame(frames)?.filename, 'app/sentry-replay-test/page.tsx');
});

test('pickSuspectFrame falls back to any frame with context when no in-app frame exists', () => {
  const frames = [
    f({ filename: 'node_modules/react-dom/index.js', inApp: false, contextLine: 'render()' }),
    f({ filename: 'node_modules/next/dist/index.js', inApp: false }),
  ];
  assert.equal(pickSuspectFrame(frames)?.filename, 'node_modules/react-dom/index.js');
});

test('pickSuspectFrame falls back to any usable-path frame when nothing has context', () => {
  const frames = [
    f({ filename: 'Unknown', inApp: true }),
    f({ filename: 'vendor/framework/src/Handler.php', inApp: false }),
  ];
  assert.equal(pickSuspectFrame(frames)?.filename, 'vendor/framework/src/Handler.php');
});

test('pickSuspectFrame falls back to the innermost frame when nothing has a usable path', () => {
  const frames = [f({ filename: 'Unknown', inApp: true }), f({ filename: '[internal]', inApp: false })];
  assert.equal(pickSuspectFrame(frames)?.filename, '[internal]', 'innermost frame (last in array, first after reverse)');
});

test('pickSuspectFrame returns undefined for an empty frame list', () => {
  assert.equal(pickSuspectFrame([]), undefined);
});
