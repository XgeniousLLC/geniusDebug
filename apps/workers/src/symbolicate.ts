import { db, releases, repositories, sourceMapArtifacts } from '@geniusdebug/db';
import { and, eq, inArray } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import type { NormalizedEvent, NormalizedFrame } from '@geniusdebug/shared';
import { getObject, r2Configured } from './r2';
import { symbolicateWithImages, sanitizeRawJsFrames, FRAMEWORK_INTERNAL_RE } from './apply-map';
import { computeCulprit, normalizeFramePath, pageOf } from '@geniusdebug/shared';

/** Uploader gzips maps before PUT (build-time cost); gunzip on read here,
 * detected by magic bytes so pre-existing plain-JSON maps in R2 still work. */
function decodeMapBytes(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return gunzipSync(b).toString('utf8');
  return b.toString('utf8');
}

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
    // Debug-ID lookup → fetch every matching map from R2 → apply per frame
    // (FR-MAP-3/4). A single error spans frames from multiple bundled chunks,
    // each with its own debug_id/map; the event's debug_meta.images pairs tell
    // us which chunk (code_file) each map (debug_id) covers, and every frame
    // resolves ONLY through its own chunk's map — applying an unrelated map
    // "successfully" mis-resolves frames (minified chunks are one long line).
    // Falls back to raw frames with a warning when none are found (FR-MAP-8).
    const images = e.debugImages ?? [];
    if (e.debugIds.length === 0) {
      console.warn(`[symbolicate] no debug_ids in event — source maps cannot be matched. Check that withSentryConfig sourcemaps.disable is NOT true.`);
    } else if (images.length === 0) {
      console.warn(`[symbolicate] event has debug_ids but no code_file pairs in debug_meta.images — frames cannot be paired to maps, keeping raw frames.`);
    }
    const artifacts = await findMapArtifacts(projectId, e.debugIds);
    if (artifacts.size === 0 && e.debugIds.length > 0) {
      console.warn(`[symbolicate] debug_ids [${e.debugIds.join(', ')}] not found in source_map_artifacts — were maps uploaded and registered?`);
    }
    if (artifacts.size > 0 && images.length > 0 && (await r2Configured())) {
      try {
        const mapsByDebugId = new Map<string, string>();
        await Promise.all(
          [...artifacts].map(async ([debugId, r2Key]) => {
            const bytes = await getObject(r2Key);
            if (bytes != null) mapsByDebugId.set(debugId, decodeMapBytes(bytes));
          }),
        );
        if (mapsByDebugId.size > 0) {
          frames = await symbolicateWithImages(frames, mapsByDebugId, images);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[symbolicate] map apply failed for [${[...artifacts.values()].join(', ')}], using raw frames:`, (err as Error).message);
      }
    }
    // Frames still raw after (or without) map application: minified chunk
    // URLs and runtime placeholders must not classify in-app (FR-MAP-5).
    frames = sanitizeRawJsFrames(frames);
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
  const culprit = computeCulprit(frames, e.culprit, pageOf(e.transaction, e.url));

  return { ...e, frames, culprit };
}

/** R2 key per matching debug_id for the event's Debug IDs (FR-MAP-2). Keyed by
 *  debug_id so each frame can be paired to its own chunk's map; first row wins
 *  when a debug_id has >1 registered row across redeploys. */
async function findMapArtifacts(projectId: string, debugIds: string[]): Promise<Map<string, string>> {
  if (debugIds.length === 0) return new Map();
  const rows = await db
    .select({ debugId: sourceMapArtifacts.debugId, r2Key: sourceMapArtifacts.r2Key })
    .from(sourceMapArtifacts)
    .where(and(eq(sourceMapArtifacts.projectId, projectId), inArray(sourceMapArtifacts.debugId, debugIds)));
  const byId = new Map<string, string>();
  for (const r of rows) {
    if (!byId.has(r.debugId)) byId.set(r.debugId, r.r2Key);
  }
  return byId;
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
  // Normalize to a repo-relative source path (belt-and-suspenders —
  // resolveFrame already normalizes symbolicated frames; this also covers
  // raw/unmapped frames, e.g. no source map found, FR-MAP-8).
  const path = normalizeFramePath(f.absPath ?? f.filename);
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return undefined; // remote asset, not a repo file
  if (FRAMEWORK_INTERNAL_RE.test(path)) return undefined; // dependency / Next.js internal, not the app's own repo
  if (!/\.(mjs|cjs|jsx?|tsx?|vue|svelte|php)$/.test(path)) return undefined; // source files only
  const line = f.lineno ? `#L${f.lineno}` : '';
  return `https://github.com/${gh.owner}/${gh.name}/blob/${gh.ref}/${path}${line}`;
}
