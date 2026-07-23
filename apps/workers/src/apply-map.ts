import { SourceMapConsumer } from 'source-map';
import type { NormalizedFrame } from '@geniusdebug/shared';

/**
 * Paths that are framework internals, not the app's own code, even though they
 * don't live under node_modules in the resolved source map (Next.js ships its
 * client runtime's own TS sources — e.g. `src/client/app-next.ts` — bundled
 * with source maps that resolve to plain `src/...` paths). Excluding these
 * keeps them out of "In App" and stops a linked GitHub repo from generating
 * broken deep-links to files that only exist in Next.js's package, not the
 * app's own repo.
 */
export const FRAMEWORK_INTERNAL_RE = /node_modules|\/framework\/|^src\/(client|server|shared|build|export)\//;

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
 * Multi-chunk variant (FR-MAP-3/4): a single stack trace can span frames from
 * several different bundled chunks (each with its own debug_id/map) — e.g. an
 * app-page frame plus a separate vendor chunk frame. Tries every available map
 * per frame and keeps the first one that produces a real mapping, instead of
 * applying just one map (previously: the first matching debug_id) to the whole
 * event, which left frames from any other chunk unresolved.
 */
export async function symbolicateWithMaps(
  frames: NormalizedFrame[],
  rawMapJsons: Array<string | object>,
): Promise<NormalizedFrame[]> {
  if (rawMapJsons.length === 0) return frames;
  const consumers = await Promise.all(rawMapJsons.map((m) => new SourceMapConsumer(m as never)));
  try {
    return frames.map((f) => {
      for (const consumer of consumers) {
        const resolved = resolveFrame(f, consumer);
        if (resolved !== f) return resolved; // first consumer with a real mapping wins
      }
      return f; // no map covered this frame — keep raw (FR-MAP-8)
    });
  } finally {
    consumers.forEach((c) => c.destroy());
  }
}

/**
 * Our own uploader reads .map files straight off disk — Sentry's own
 * `rewriteSources` normalization (which strips this) never runs, since that's
 * part of the SaaS-upload pipeline we don't use (no auth token). So every
 * resolved `sources` entry still carries webpack's raw `webpack://_N_E/...`
 * (or bare `webpack://...`) scheme prefix unless we strip it ourselves.
 */
function cleanSourcePath(source: string): string {
  return source.replace(/^webpack:\/\/(?:_N_E\/)?/, '');
}

export function resolveFrame(f: NormalizedFrame, consumer: SourceMapConsumer): NormalizedFrame {
  if (f.lineno == null) return f;
  const pos = consumer.originalPositionFor({ line: f.lineno, column: f.colno ?? 0 });
  if (!pos.source || pos.line == null) return f; // no mapping → keep raw frame (FR-MAP-8)
  const source = cleanSourcePath(pos.source);

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
