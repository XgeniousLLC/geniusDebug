import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapGenerator } from 'source-map';
import { symbolicateWithMap, symbolicateWithImages, debugIdForFrame, sanitizeRawJsFrames } from './apply-map';
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

const BUNDLE_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR_ID = '22222222-2222-2222-2222-222222222222';

test('multi-chunk stack: each frame resolves ONLY through its own chunk\'s map, paired by debug_meta.images (FR-MAP-3)', async () => {
  const appFrame: NormalizedFrame = { filename: 'bundle.js', absPath: 'app:///_next/static/chunks/bundle.js', lineno: 1, colno: 100, inApp: false };
  const vendorFrame: NormalizedFrame = { filename: 'vendor.js', absPath: 'app:///_next/static/chunks/vendor.js', lineno: 5, colno: 20, inApp: false };
  const [a, v] = await symbolicateWithImages(
    [appFrame, vendorFrame],
    new Map([
      [BUNDLE_ID, fixtureMap()],
      [VENDOR_ID, secondChunkMap()],
    ]),
    [
      { codeFile: 'app:///_next/static/chunks/bundle.js', debugId: BUNDLE_ID },
      { codeFile: 'app:///_next/static/chunks/vendor.js', debugId: VENDOR_ID },
    ],
  );

  assert.equal(a.filename, 'stores/inbox/useInboxConversations.ts', 'app frame resolved via its own map');
  assert.equal(v.filename, 'lib/format.ts', 'vendor frame resolved via its own map, not left raw');
  assert.equal(v.function, 'formatDate');
});

test('multi-chunk stack: a frame with no image entry stays raw, others still resolve (FR-MAP-8)', async () => {
  const unmatched: NormalizedFrame = { filename: 'other.js', absPath: 'app:///_next/static/chunks/other.js', lineno: 999, colno: 1, inApp: false };
  const appFrame: NormalizedFrame = { filename: 'bundle.js', absPath: 'app:///_next/static/chunks/bundle.js', lineno: 1, colno: 100, inApp: false };
  const [u, a] = await symbolicateWithImages(
    [unmatched, appFrame],
    new Map([[BUNDLE_ID, fixtureMap()]]),
    [{ codeFile: 'app:///_next/static/chunks/bundle.js', debugId: BUNDLE_ID }],
  );

  assert.equal(u.filename, 'other.js', 'no image matched — kept raw, not crashed or wrongly resolved');
  assert.equal(a.filename, 'stores/inbox/useInboxConversations.ts', 'sibling frame in the same event still resolves');
});

test('REGRESSION: a wrong chunk\'s map covering the same coordinates must NOT win (mis-resolution bug)', async () => {
  // A framework chunk's map that ALSO has a mapping at line 1 column 100 —
  // exactly the coordinates of the app frame. Under the old try-every-map
  // strategy this map could "successfully" resolve the app frame into
  // node_modules/next internals; with image pairing it must never be applied
  // to a frame from a different chunk.
  const g = new SourceMapGenerator({ file: 'framework.js' });
  g.addMapping({
    generated: { line: 1, column: 100 },
    original: { line: 49, column: 12 },
    source: 'turbopack:///[project]/node_modules/next/src/client/app-bootstrap.ts',
  });
  g.setSourceContent(
    'turbopack:///[project]/node_modules/next/src/client/app-bootstrap.ts',
    Array.from({ length: 50 }, (_, i) => `// next internals line ${i + 1}`).join('\n'),
  );
  const FRAMEWORK_ID = '33333333-3333-3333-3333-333333333333';

  const appFrame: NormalizedFrame = { filename: 'bundle.js', absPath: 'app:///_next/static/chunks/bundle.js', lineno: 1, colno: 100, inApp: false };
  // Framework map listed FIRST — the old implementation would have used it.
  const [a] = await symbolicateWithImages(
    [appFrame],
    new Map([
      [FRAMEWORK_ID, g.toString()],
      [BUNDLE_ID, fixtureMap()],
    ]),
    [
      { codeFile: 'app:///_next/static/chunks/framework.js', debugId: FRAMEWORK_ID },
      { codeFile: 'app:///_next/static/chunks/bundle.js', debugId: BUNDLE_ID },
    ],
  );

  assert.equal(a.filename, 'stores/inbox/useInboxConversations.ts', 'app frame resolved via its OWN map');
  assert.equal(a.inApp, true, 'and classifies in-app — not mis-resolved into Next.js internals');
});

test('debugIdForFrame: exact code_file match, and pathname-tail fallback across scheme/host differences', () => {
  const images = [{ codeFile: 'app:///_next/static/chunks/bundle.js', debugId: BUNDLE_ID }];
  assert.equal(
    debugIdForFrame({ absPath: 'app:///_next/static/chunks/bundle.js', inApp: false }, images),
    BUNDLE_ID,
  );
  assert.equal(
    debugIdForFrame({ absPath: 'https://crm.example.com/_next/static/chunks/bundle.js', inApp: false }, images),
    BUNDLE_ID,
    'https frame path matches app:/// image path by /_next/... tail',
  );
  assert.equal(
    debugIdForFrame({ absPath: 'https://crm.example.com/_next/static/chunks/nope.js', inApp: false }, images),
    undefined,
  );
  assert.equal(debugIdForFrame({ inApp: false }, images), undefined, 'pathless frame → no pairing');
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

test('Turbopack-resolved Next.js internal source (turbopack:///[project]/src/client/...) is not flagged in-app', async () => {
  // Regression: FRAMEWORK_INTERNAL_RE's `^src/...` alternative is anchored to
  // string-start; the unstripped turbopack:///[project]/ prefix broke that
  // anchor and left framework-internal frames misclassified as in-app.
  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({ generated: { line: 1, column: 0 }, original: { line: 7, column: 10 }, source: 'turbopack:///[project]/src/client/app-next.ts' });
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 0, inApp: true };
  const [f] = await symbolicateWithMap([minified], g.toString());
  assert.equal(f.filename, 'src/client/app-next.ts');
  assert.equal(f.inApp, false, 'Next.js framework internals resolved via Turbopack must not read as the app\'s own code');
});

test('Turbopack-resolved app source (turbopack:///[project]/app/...) IS flagged in-app', async () => {
  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({ generated: { line: 1, column: 0 }, original: { line: 71, column: 21 }, source: 'turbopack:///[project]/app/sentry-replay-test/page.tsx' });
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 0, inApp: false };
  const [f] = await symbolicateWithMap([minified], g.toString());
  assert.equal(f.filename, 'app/sentry-replay-test/page.tsx');
  assert.equal(f.inApp, true);
});

test('Turbopack runtime source ([turbopack]/browser/runtime/...) is not flagged in-app', async () => {
  // "Failed to load chunk" errors are thrown by Turbopack's own runtime; its
  // sources resolve to [turbopack]/... paths, which are framework internals.
  const g = new SourceMapGenerator({ file: 'bundle.js' });
  g.addMapping({ generated: { line: 1, column: 0 }, original: { line: 233, column: 22 }, source: 'turbopack:///[turbopack]/browser/runtime/base/runtime-base.ts' });
  const minified: NormalizedFrame = { filename: 'bundle.js', lineno: 1, colno: 0, inApp: true };
  const [f] = await symbolicateWithMap([minified], g.toString());
  assert.equal(f.filename, '[turbopack]/browser/runtime/base/runtime-base.ts');
  assert.equal(f.inApp, false, 'bundler runtime must not read as the app\'s own code');
});

test('sanitizeRawJsFrames: unresolved chunk URLs and runtime placeholders lose their SDK in_app flag', () => {
  const frames: NormalizedFrame[] = [
    { filename: '<anonymous>', function: 'Array.reduce', inApp: true },
    { absPath: 'app:///_next/static/chunks/77183-ee940e82975cb0f0.js', lineno: 2, colno: 62423, inApp: true },
    { absPath: 'https://crm.example.com/_next/static/chunks/webpack-d1e8e2013f8d2416.js', lineno: 1, colno: 1409, inApp: true },
    { absPath: 'app/real/page.tsx', contextLine: 'const x = 1;', inApp: true }, // resolved — untouched
    { inApp: true }, // pathless
  ];
  const [anon, chunk, webpack, resolved, pathless] = sanitizeRawJsFrames(frames);
  assert.equal(anon.inApp, false, '<anonymous> is not app code');
  assert.equal(chunk.inApp, false, 'minified /_next/static chunk is not app code');
  assert.equal(webpack.inApp, false, 'webpack runtime chunk is not app code');
  assert.equal(resolved.inApp, true, 'symbolicated app frame keeps its classification');
  assert.equal(pathless.inApp, false, 'pathless frame cannot be app code');
});

test('sanitizeRawJsFrames: SSR server chunks lose in_app even when the server SDK attached source context', () => {
  // Node-side SDK reads bundled files off disk, so these frames arrive with
  // contextLine set — they are still bundled output, not the app's code.
  const frames: NormalizedFrame[] = [
    { absPath: 'app:///_next/server/chunks/ssr/[turbopack]_runtime.js', function: 'instantiateModule', lineno: 853, colno: 9, contextLine: 'const module1 = createModuleWithDirection(id);', inApp: true },
    { absPath: 'app:///_next/server/chunks/ssr/[root-of-the-server]__0hw7z76._.js', lineno: 8, colno: 66303, inApp: true },
    { absPath: '/var/task/node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js', lineno: 52, colno: 24384, inApp: true },
  ];
  for (const f of sanitizeRawJsFrames(frames)) {
    assert.equal(f.inApp, false, `${f.absPath} must not classify in-app`);
  }
});

test('debugIdForFrame: server-side disk-path image (.next) pairs with rewritten frame path (_next) by unique basename', () => {
  const images = [
    { codeFile: '/var/task/.next/server/chunks/ssr/%5Bturbopack%5D_runtime.js', debugId: VENDOR_ID },
    { codeFile: '/var/task/.next/server/chunks/ssr/page_abc123._.js', debugId: BUNDLE_ID },
  ];
  assert.equal(
    debugIdForFrame({ absPath: 'app:///_next/server/chunks/ssr/page_abc123._.js', inApp: false }, images),
    BUNDLE_ID,
  );
  // ambiguous basename (two images share it) → no guess
  const dup = [
    { codeFile: '/var/task/.next/server/chunks/ssr/x.js', debugId: BUNDLE_ID },
    { codeFile: '/var/task/.next/server/other/x.js', debugId: VENDOR_ID },
  ];
  assert.equal(debugIdForFrame({ absPath: 'app:///_next/server/chunks/ssr/x.js', inApp: false }, dup), undefined);
});
