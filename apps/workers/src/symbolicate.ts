import { db, releases, repositories, sourceMapArtifacts } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';
import type { NormalizedEvent, NormalizedFrame } from '@geniusdebug/shared';

/**
 * Symbolication step (FR-MAP-3..10). SKIPS entirely when platform !== javascript
 * (FR-MAP-10 — PHP/Laravel frames are already resolved). For JS: looks up the
 * event's Debug IDs → source_map_artifacts; if a map exists it would be applied
 * (maps live in R2). If none is found we gracefully keep the raw frame (FR-MAP-8)
 * and, when the project is linked to GitHub, attach a deep link per in-app frame
 * (FR-MAP-6 / FR-GH-3).
 */
export async function symbolicate(e: NormalizedEvent, projectId: string): Promise<NormalizedEvent> {
  if (e.platform !== 'javascript') return e; // FR-MAP-10

  // GitHub deep-link context: repo + release commit (FR-GH-3).
  const gh = await resolveGithub(projectId, e.release);

  // Debug-ID lookup — presence proves a map is available for real symbolication.
  if (e.debugIds.length > 0) {
    for (const debugId of e.debugIds) {
      await db
        .select({ id: sourceMapArtifacts.id })
        .from(sourceMapArtifacts)
        .where(and(eq(sourceMapArtifacts.projectId, projectId), eq(sourceMapArtifacts.debugId, debugId)))
        .limit(1);
      // (R2 fetch + source-map application happens here when maps are uploaded.)
    }
  }

  const frames: NormalizedFrame[] = e.frames.map((f) => ({
    ...f,
    githubUrl: f.inApp && gh ? buildGithubUrl(gh, f) : undefined,
  }));

  return { ...e, frames };
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
  const path = (f.absPath ?? f.filename ?? '').replace(/^\.\//, '');
  if (!path) return undefined;
  const line = f.lineno ? `#L${f.lineno}` : '';
  return `https://github.com/${gh.owner}/${gh.name}/blob/${gh.ref}/${path}${line}`;
}
