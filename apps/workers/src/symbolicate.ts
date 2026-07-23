import { db, releases, repositories, sourceMapArtifacts } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';
import type { NormalizedEvent, NormalizedFrame } from '@geniusdebug/shared';
import { getObject, r2Configured } from './r2';
import { symbolicateWithMap } from './apply-map';

/**
 * Symbolication step (FR-MAP-3..10). Map-based symbolication SKIPS when
 * platform !== javascript (FR-MAP-10 — PHP/Laravel frames are already
 * resolved, no minified source to un-map). For JS: looks up the event's
 * Debug IDs → source_map_artifacts; if a map exists it's applied (maps live
 * in R2). If none is found we gracefully keep the raw frame (FR-MAP-8).
 * GitHub deep-linking (FR-MAP-6 / FR-GH-3) runs for EVERY platform — a
 * linked repo should deep-link PHP frames just as much as JS ones.
 */
export async function symbolicate(e: NormalizedEvent, projectId: string): Promise<NormalizedEvent> {
  // GitHub deep-link context: repo + release commit (FR-GH-3).
  const gh = await resolveGithub(projectId, e.release);

  let frames: NormalizedFrame[] = e.frames;

  if (e.platform === 'javascript') {
    // Debug-ID lookup → fetch the map from R2 → apply it (FR-MAP-3/4). Falls back
    // to the raw frames with a warning when no map is found/available (FR-MAP-8).
    if (e.debugIds.length === 0) {
      console.warn(`[symbolicate] no debug_ids in event — source maps cannot be matched. Check that withSentryConfig sourcemaps.disable is NOT true.`);
    }
    const r2Key = await findMapR2Key(projectId, e.debugIds);
    if (!r2Key && e.debugIds.length > 0) {
      console.warn(`[symbolicate] debug_ids [${e.debugIds.join(', ')}] not found in source_map_artifacts — were maps uploaded and registered?`);
    }
    if (r2Key && (await r2Configured())) {
      try {
        const bytes = await getObject(r2Key);
        if (bytes) frames = await symbolicateWithMap(frames, bytes.toString('utf8'));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[symbolicate] map apply failed for ${r2Key}, using raw frames:`, (err as Error).message);
      }
    }
  } // FR-MAP-10

  // Deep-link any project source file to GitHub (FR-MAP-6) when a repo is linked —
  // not only strict in-app frames, so app/ files the SDK flagged non-app still link.
  frames = frames.map((f) => ({
    ...f,
    githubUrl: gh ? buildGithubUrl(gh, f) : undefined,
  }));

  // Culprit was computed in normalize() from the raw (pre-symbolication) top
  // in-app frame — refresh it from the resolved frames so a successfully
  // symbolicated event doesn't keep showing the minified chunk path (FR-GRP-3).
  const topInApp = [...frames].reverse().find((f) => f.inApp) ?? frames[frames.length - 1];
  const culprit = topInApp?.absPath ?? topInApp?.module ?? topInApp?.filename ?? e.culprit;

  return { ...e, frames, culprit };
}

/** First matching artifact's R2 key for any of the event's Debug IDs (FR-MAP-2). */
async function findMapR2Key(projectId: string, debugIds: string[]): Promise<string | null> {
  for (const debugId of debugIds) {
    const rows = await db
      .select({ r2Key: sourceMapArtifacts.r2Key })
      .from(sourceMapArtifacts)
      .where(and(eq(sourceMapArtifacts.projectId, projectId), eq(sourceMapArtifacts.debugId, debugId)))
      .limit(1);
    if (rows[0]) return rows[0].r2Key;
  }
  return null;
}

interface GhCtx {
  owner: string;
  name: string;
  ref: string; // commit sha or branch
}

async function resolveGithub(projectId: string, release?: string): Promise<GhCtx | null> {
  const repoRows = await db
    .select({ owner: repositories.owner, name: repositories.name, defaultBranch: repositories.defaultBranch, id: repositories.id })
    .from(repositories)
    .where(eq(repositories.projectId, projectId))
    .limit(1);
  if (repoRows.length === 0) return null;
  const repo = repoRows[0];

  let ref = repo.defaultBranch;
  if (release) {
    const rel = await db
      .select({ commitSha: releases.commitSha })
      .from(releases)
      .where(and(eq(releases.projectId, projectId), eq(releases.version, release)))
      .limit(1);
    if (rel[0]?.commitSha) ref = rel[0].commitSha;
  }
  return { owner: repo.owner, name: repo.name, ref };
}

function buildGithubUrl(gh: GhCtx, f: NormalizedFrame): string | undefined {
  // Normalize to a repo-relative source path.
  const path = (f.absPath ?? f.filename ?? '')
    .replace(/^webpack-internal:\/\/\/(\(.*?\)\/)?/, '') // Next.js dev prefix
    .replace(/^(https?:\/\/[^/]+\/)?_next\/(app|src)\//, '$2/') // built asset → src path
    .replace(/^\.\//, '');
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return undefined; // remote asset, not a repo file
  if (path.includes('node_modules/')) return undefined; // dependency, not our source
  if (!/\.(mjs|cjs|jsx?|tsx?|vue|svelte|php)$/.test(path)) return undefined; // source files only
  const line = f.lineno ? `#L${f.lineno}` : '';
  return `https://github.com/${gh.owner}/${gh.name}/blob/${gh.ref}/${path}${line}`;
}
