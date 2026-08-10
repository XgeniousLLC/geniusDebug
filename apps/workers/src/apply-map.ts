import { SourceMapConsumer } from 'source-map';
import type { DebugImage, NormalizedFrame } from '@geniusdebug/shared';
import { normalizeFramePath } from '@geniusdebug/shared';

/**
 * Paths that are framework internals, not the app's own code, even though they
 * don't live under node_modules in the resolved source map (Next.js ships its
 * client runtime's own TS sources — e.g. `src/client/app-next.ts` — bundled
 * with source maps that resolve to plain `src/...` paths). Excluding these
 * keeps them out of "In App" and stops a linked GitHub repo from generating
 * broken deep-links to files that only exist in Next.js's package, not the
 * app's own repo.
 */
export const FRAMEWORK_INTERNAL_RE =
  /node_modules|\/framework\/|^src\/(client|server|shared|build|export)\/|^\[turbopack\]\/|^\[next\]\/|^node:/;

/**
 * Apply a source map to minified frames (FR-MAP-3/4): resolve bundle line/col back
 * to original file/line/col/function and attach source context from the map's
 * `sourcesContent`. In-app vs framework is re-derived from the resolved path
 * (FR-MAP-5). The raw map bytes come from R2 (see symbolicate.ts / r2.ts).
 */
export async function symbolicateWithMap(
  frames: NormalizedFrame[],
  rawMapJson: string | object,
): Promise<NormalizedFrame[]> {
  const consumer = await new SourceMapConsumer(rawMapJson as never);
  try {
    return frames.map((f) => resolveFrame(f, consumer));
  } finally {
    consumer.destroy();
  }
}

/**
 * Multi-chunk variant (FR-MAP-3/4): a single stack trace spans frames from
 * several bundled chunks, each with its own debug_id/map. Every frame resolves
 * ONLY through its own chunk's map, paired via the event's debug_meta.images
 * (frame abs_path ↔ image code_file ↔ debug_id).
 *
 * The previous implementation tried every available map per frame and kept
 * the first one that returned a mapping — but minified chunks are one long
 * line, so the WRONG chunk's map still returns a plausible-looking original
 * position for almost any column. In practice large framework chunk maps
 * (Next.js runtime) won that race for app-code frames, mis-resolving them
 * into node_modules/next/src/... and leaving no in-app frame on the event.
 *
 * A frame whose chunk has no image entry or no fetched map stays raw
 * (FR-MAP-8) — a raw chunk path is honest; a wrong "original" path is worse.
 */
export async function symbolicateWithImages(
  frames: NormalizedFrame[],
  mapsByDebugId: Map<string, string | object>,
  images: DebugImage[],
): Promise<NormalizedFrame[]> {
  if (mapsByDebugId.size === 0 || images.length === 0) return frames;
  const consumers = new Map<string, SourceMapConsumer>();
  for (const [debugId, raw] of mapsByDebugId) {
    consumers.set(debugId, await new SourceMapConsumer(raw as never));
  }
  try {
    return frames.map((f) => {
      const debugId = debugIdForFrame(f, images);
      const consumer = debugId ? consumers.get(debugId) : undefined;
      return consumer ? resolveFrame(f, consumer) : f;
    });
  } finally {
    consumers.forEach((c) => c.destroy());
  }
}

/**
 * The debug_id covering this frame's chunk: exact code_file match on the
 * frame's abs_path/filename first, then a pathname-tail match to tolerate
 * scheme/host differences between what the SDK stamps on images
 * (`app:///_next/static/chunks/X.js`) and on frames
 * (`https://host/_next/static/chunks/X.js`, or vice versa).
 */
export function debugIdForFrame(f: NormalizedFrame, images: DebugImage[]): string | undefined {
  const path = f.absPath ?? f.filename;
  if (!path) return undefined;
  const exact = images.find((img) => img.codeFile === path);
  if (exact) return exact.debugId;
  const tail = pathTail(path);
  if (!tail) return undefined;
  return images.find((img) => pathTail(img.codeFile) === tail)?.debugId;
}

/** Scheme/host-independent tail of a chunk URL (prefers the `/_next/...` part). */
function pathTail(p: string): string | undefined {
  return /(\/_next\/.+)$/.exec(p)?.[1] ?? /(\/[^/]+)$/.exec(p)?.[1];
}

/** Minified build assets and JS-runtime placeholders — never the app's own
 * readable code, regardless of what the SDK's client-side in_app guess said. */
const MINIFIED_ASSET_RE = /\/_next\/static\/|^_next\/static\/|(^|\/)webpack(-[0-9a-f]+)?\.js$/;
const RUNTIME_PLACEHOLDERS = new Set(['<anonymous>', 'native', '[native code]', 'eval']);

/**
 * Post-symbolication in-app sanitation for JS events (FR-MAP-5): any frame
 * still pointing at a minified chunk (`/_next/static/...`, hashed webpack
 * chunks — e.g. an old release whose maps were never uploaded) or at a
 * runtime placeholder (`<anonymous>`, `native`) must not classify in-app.
 * The browser SDK stamps in_app=true on all of these client-side (it can't
 * know better before symbolication), which otherwise promotes an unreadable
 * frame to suspect/culprit over the honest page-level fallback.
 * Frames symbolication resolved already had inApp re-derived in resolveFrame
 * and keep it.
 */
export function sanitizeRawJsFrames(frames: NormalizedFrame[]): NormalizedFrame[] {
  return frames.map((f) => {
    if (!f.inApp) return f;
    const p = (f.absPath ?? f.filename)?.trim();
    if (!p) return { ...f, inApp: false };
    if (RUNTIME_PLACEHOLDERS.has(p.toLowerCase())) return { ...f, inApp: false };
    if (MINIFIED_ASSET_RE.test(p)) return { ...f, inApp: false };
    return f;
  });
}

export function resolveFrame(f: NormalizedFrame, consumer: SourceMapConsumer): NormalizedFrame {
  if (f.lineno == null) return f;
  const pos = consumer.originalPositionFor({ line: f.lineno, column: f.colno ?? 0 });
  if (!pos.source || pos.line == null) return f; // no mapping → keep raw frame (FR-MAP-8)
  // Our own uploader reads .map files straight off disk — Sentry's own
  // `rewriteSources` normalization (which strips this) never runs, since
  // that's part of the SaaS-upload pipeline we don't use (no auth token). So
  // every resolved `sources` entry still carries the bundler's raw scheme
  // prefix (webpack://_N_E/..., turbopack:///[project]/...) unless we strip
  // it ourselves — and FRAMEWORK_INTERNAL_RE's anchored `^src/...`
  // alternative needs that stripped, normalized path to match consistently
  // across bundlers.
  const source = normalizeFramePath(pos.source) ?? pos.source;

  const resolved: NormalizedFrame = {
    ...f,
    filename: source,
    absPath: source,
    function: pos.name ?? f.function,
    lineno: pos.line,
    colno: pos.column ?? f.colno,
    inApp: !FRAMEWORK_INTERNAL_RE.test(source),
  };

  const content = consumer.sourceContentFor(pos.source, true);
  if (content) {
    const lines = content.split('\n');
    const idx = pos.line - 1;
    resolved.preContext = lines.slice(Math.max(0, idx - 2), idx);
    resolved.contextLine = lines[idx];
    resolved.postContext = lines.slice(idx + 1, idx + 3);
  }
  return resolved;
}
