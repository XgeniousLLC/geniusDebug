import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapGenerator } from 'source-map';
import { symbolicateWithMap } from './apply-map';
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
