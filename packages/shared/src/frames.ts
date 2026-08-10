import type { NormalizedFrame } from './domain';
import { hasUsableFramePath } from './culprit';

/**
 * Strips bundler/scheme prefixes a resolved (or raw) frame path can carry —
 * webpack, webpack-internal (Next dev), Turbopack (Next 16+), and a built
 * `_next/(app|src)/` asset prefix — down to one canonical relative path.
 * Single source of truth shared by symbolication (in-app classification,
 * GitHub deep-links) and every display site, replacing 5 previously
 * duplicated, inconsistent regex chains.
 */
export function normalizeFramePath(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/^webpack-internal:\/\/\/(\(.*?\)\/)?/, '')
    .replace(/^webpack:\/\/(?:_N_E\/)?/, '')
    .replace(/^turbopack:\/\/\/(?:\[project\]\/)?/, '')
    .replace(/^(https?:\/\/[^/]+\/)?_next\/(app|src)\//, '$2/')
    .replace(/^\.\//, '');
}

/**
 * The frame most likely responsible for the crash (FR-GRP-3 / FR-MAP-5
 * display twin): in-app must always beat non-in-app, even when the in-app
 * frame lacks resolved source context — a frame can be `inApp:true` with
 * `contextLine:undefined` (its own chunk's map had no sourcesContent) while
 * an unrelated framework frame resolved with full context from a different
 * chunk's map; picking on context availability alone (ignoring inApp) wrongly
 * promotes that framework frame. Single implementation shared by the
 * "Crashed in" summary, the Suspect-frame card, and the AI-agent markdown
 * export — previously three separately-maintained, inconsistent copies.
 */
export function pickSuspectFrame(frames: NormalizedFrame[]): NormalizedFrame | undefined {
  if (frames.length === 0) return undefined;
  const ordered = [...frames].reverse(); // crashing frame first
  return (
    ordered.find((f) => f.inApp && f.contextLine != null) ??
    ordered.find((f) => f.inApp && hasUsableFramePath(f)) ??
    ordered.find((f) => f.contextLine != null) ??
    ordered.find(hasUsableFramePath) ??
    ordered[0]
  );
}
