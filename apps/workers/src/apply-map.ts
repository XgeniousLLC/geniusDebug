import { SourceMapConsumer } from 'source-map';
import type { NormalizedFrame } from '@geniusdebug/shared';

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

export function resolveFrame(f: NormalizedFrame, consumer: SourceMapConsumer): NormalizedFrame {
  if (f.lineno == null) return f;
  const pos = consumer.originalPositionFor({ line: f.lineno, column: f.colno ?? 0 });
  if (!pos.source || pos.line == null) return f; // no mapping → keep raw frame (FR-MAP-8)

  const resolved: NormalizedFrame = {
    ...f,
    filename: pos.source,
    absPath: pos.source,
    function: pos.name ?? f.function,
    lineno: pos.line,
    colno: pos.column ?? f.colno,
    inApp: !/node_modules|\/framework\//.test(pos.source),
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
