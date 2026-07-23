import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapGenerator } from 'source-map';
import { symbolicateWithMap, symbolicateWithMaps } from './apply-map';
import type { NormalizedFrame } from '@geniusdebug/shared';

/** Build a fixture map: minified bundle.js:1:100 → the real crashing line 42. */
function fixtureMap(): string {
  const original = [
    'export function useInboxConversations() {', // 1
    ...Array.from({ length: 39 }, (_, i) => `  // line ${i + 2}`), // 2..40
    'async function fetchConversations(url) {', // 41
    '  const data = await res.json();', // 42
    '  return data.conversations;', // 43
    '}', // 44
  ].join('\n');

  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({
    generated: { line: 1, column: 100 },
    original: { line: 42, column: 10 },
    source: 'stores/inbox/useInboxConversations.ts',
    name: 'fetchConversations',
  });
  g.setSourceContent('stores/inbox/useInboxConversations.ts', original);
  return g.toString();
}

test('minified frame resolves to original file/line/function + source context (FR-MAP-3/4)', async () => {
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 100, inApp: false };
  const [f] = await symbolicateWithMap([minified], fixtureMap());

  assert.equal(f.filename, 'stores/inbox/useInboxConversations.ts');
  assert.equal(f.lineno, 42);
  assert.equal(f.function, 'fetchConversations');
  assert.equal(f.inApp, true, 'resolved app path is in-app (FR-MAP-5)');
  assert.equal(f.contextLine, '  const data = await res.json();');
  assert.ok((f.preContext ?? []).some((l) => l.includes('fetchConversations')), 'pre-context present');
});

test('unmapped frame is kept raw (graceful fallback, FR-MAP-8)', async () => {
  const raw: NormalizedFrame = { filename: 'bundle.js', lineno: 999, colno: 5, inApp: false };
  const [f] = await symbolicateWithMap([raw], fixtureMap());
  assert.equal(f.filename, 'bundle.js');
  assert.equal(f.lineno, 999);
});

/** A second chunk's map, distinct from fixtureMap() (different generated coordinates). */
function secondChunkMap(): string {
  const g = new SourceMapGenerator({ file: 'vendor.js' });
  g.addMapping({
    generated: { line: 5, column: 20 },
    original: { line: 3, column: 2 },
    source: 'lib/format.ts',
    name: 'formatDate',
  });
  g.setSourceContent('lib/format.ts', 'export function formatDate() {\n  //\n  return new Date();\n}');
  return g.toString();
}

test('multi-chunk stack: each frame resolves against whichever map actually covers it (FR-MAP-3)', async () => {
  const appFrame: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 100, inApp: false };
  const vendorFrame: NormalizedFrame = { filename: 'vendor.js', lineno: 5, colno: 20, inApp: false };
  const [a, v] = await symbolicateWithMaps([appFrame, vendorFrame], [fixtureMap(), secondChunkMap()]);

  assert.equal(a.filename, 'stores/inbox/useInboxConversations.ts', 'app frame resolved via the first map');
  assert.equal(v.filename, 'lib/format.ts', 'vendor frame resolved via the second map, not left raw');
  assert.equal(v.function, 'formatDate');
});

test('multi-chunk stack: a frame no map covers stays raw, others still resolve (FR-MAP-8)', async () => {
  const unmatched: NormalizedFrame = { filename: 'other.js', lineno: 999, colno: 1, inApp: false };
  const appFrame: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 100, inApp: false };
  const [u, a] = await symbolicateWithMaps([unmatched, appFrame], [fixtureMap(), secondChunkMap()]);

  assert.equal(u.filename, 'other.js', 'no map matched — kept raw, not crashed or wrongly resolved');
  assert.equal(a.filename, 'stores/inbox/useInboxConversations.ts', 'sibling frame in the same event still resolves');
});

test('resolved source strips the webpack://_N_E/ scheme prefix (our uploader never runs rewriteSources)', async () => {
  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: 'webpack://_N_E/app/page.tsx' });
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 0, inApp: false };
  const [f] = await symbolicateWithMap([minified], g.toString());
  assert.equal(f.filename, 'app/page.tsx');
  assert.equal(f.absPath, 'app/page.tsx');
});

test('Next.js internal source (webpack://_N_E/src/client/...) is not flagged in-app', async () => {
  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({ generated: { line: 1, column: 0 }, original: { line: 7, column: 10 }, source: 'webpack://_N_E/src/client/app-next.ts' });
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 0, inApp: true };
  const [f] = await symbolicateWithMap([minified], g.toString());
  assert.equal(f.filename, 'src/client/app-next.ts');
  assert.equal(f.inApp, false, 'Next.js framework internals must not read as the app\'s own code');
});
