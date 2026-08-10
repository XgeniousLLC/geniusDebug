import type { NormalizedFrame } from './domain';

/**
 * SDK-emitted placeholders for a frame whose file the SDK couldn't resolve
 * (seen from sentry-php on shutdown-captured fatals: `file: "Unknown"` on
 * the only in_app-flagged frame, with no real backtrace to the actual
 * trigger — see FR-GRP-3). Never usable as a culprit/display path.
 */
const PLACEHOLDER_FILES = new Set([
  'unknown',
  '[internal]',
  '',
  // JS runtime placeholders — `Array.reduce` in `<anonymous>` etc. carry no
  // navigable file; showing them as the culprit/suspect is worse than the
  // page-level fallback.
  '<anonymous>',
  'native',
  '[native code]',
  'eval',
]);

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
 * True if this frame has a real file the UI can show (not an SDK placeholder
 * like `"Unknown"`/`"[internal]"`/empty). Shared with the web app so the
 * "Crashed in" summary / featured frame doesn't pick an unresolvable frame
 * over a sibling that actually has a usable path, same fallback intent as
 * computeCulprit().
 */
export function hasUsableFramePath(f: NormalizedFrame): boolean {
  return framePath(f) !== undefined;
}

/** Page-level culprit fallback: parameterized transaction when the SDK sent
 * one, else the URL's pathname (some events — e.g. errors before routing
 * settles — carry a url but no transaction). */
export function pageOf(transaction?: string, url?: string): string | undefined {
  if (transaction) return transaction;
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/**
 * Culprit = the top in-app frame's path (FR-GRP-3), skipping frames the SDK
 * couldn't resolve a real file for (e.g. sentry-php's "Unknown" placeholder
 * on shutdown-captured fatals — showing that as the culprit is worse than
 * useless, it looks like a real path but isn't). Falls through: last in-app
 * frame with a usable path → the transaction (page/route), when provided →
 * any frame (in-app or not) with a usable path → the previous culprit.
 *
 * The transaction beats non-app frame paths deliberately: for errors thrown
 * entirely inside framework code (React hydration mismatches, Next runtime
 * errors) every frame is under node_modules, and headlining the issue with
 * `node_modules/next/dist/compiled/react-dom/...` is noise — "which page did
 * this happen on" is the useful headline (this is also what Sentry shows).
 */
/** Top (innermost) in-app frame's usable path, or undefined. */
export function topInAppFramePath(frames: NormalizedFrame[]): string | undefined {
  for (const f of [...frames].reverse()) {
    if (!f.inApp) continue;
    const path = framePath(f);
    if (path) return path;
  }
  return undefined;
}

export function computeCulprit(
  frames: NormalizedFrame[],
  previous?: string,
  transaction?: string,
): string | undefined {
  const inApp = topInAppFramePath(frames);
  if (inApp) return inApp;
  if (transaction) return transaction;
  for (const f of [...frames].reverse()) {
    const path = framePath(f);
    if (path) return path;
  }
  return previous;
}
