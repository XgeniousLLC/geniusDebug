import type { NormalizedFrame } from './domain';

/**
 * SDK-emitted placeholders for a frame whose file the SDK couldn't resolve
 * (seen from sentry-php on shutdown-captured fatals: `file: "Unknown"` on
 * the only in_app-flagged frame, with no real backtrace to the actual
 * trigger — see FR-GRP-3). Never usable as a culprit/display path.
 */
const PLACEHOLDER_FILES = new Set(['unknown', '[internal]', '']);

function isUsable(path: string | undefined | null): path is string {
  return !!path && !PLACEHOLDER_FILES.has(path.trim().toLowerCase());
}

/**
 * Pick the frame's display path (absPath ?? module ?? filename), or undefined
 * if none of those are usable.
 */
function framePath(f: NormalizedFrame): string | undefined {
  return [f.absPath, f.module, f.filename].find(isUsable);
}

/**
 * Culprit = the top in-app frame's path (FR-GRP-3), skipping frames the SDK
 * couldn't resolve a real file for (e.g. sentry-php's "Unknown" placeholder
 * on shutdown-captured fatals — showing that as the culprit is worse than
 * useless, it looks like a real path but isn't). Falls through: last in-app
 * frame with a usable path → any frame (in-app or not) with a usable path →
 * the previous culprit, if any.
 */
export function computeCulprit(frames: NormalizedFrame[], previous?: string): string | undefined {
  const inAppFrames = [...frames].reverse().filter((f) => f.inApp);
  for (const f of inAppFrames) {
    const path = framePath(f);
    if (path) return path;
  }
  for (const f of [...frames].reverse()) {
    const path = framePath(f);
    if (path) return path;
  }
  return previous;
}
