import { db, sql, events, replays, sourceMapArtifacts, releases, issueCounts } from '@geniusdebug/db';
import { lt, inArray } from 'drizzle-orm';
import { deleteObjects } from './r2';

/**
 * Retention purge (FR-RET-1, FR-MAP-9). Deletes aged events, replays, and the
 * source maps of aged releases from Postgres, and their blobs from R2. Cost
 * discipline is a feature (golden rule 6). Windows are configurable via env.
 */
const EVENT_DAYS = Number(process.env.RETENTION_EVENT_DAYS ?? 30);
const REPLAY_DAYS = Number(process.env.RETENTION_REPLAY_DAYS ?? 14);
const MAP_DAYS = Number(process.env.RETENTION_MAP_DAYS ?? 90);

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export async function purge(): Promise<{ events: number; replays: number; maps: number }> {
  // Replays: delete R2 blobs first (by prefix), then metadata.
  const oldReplays = await db
    .select({ id: replays.id, r2Prefix: replays.r2Prefix })
    .from(replays)
    .where(lt(replays.createdAt, cutoff(REPLAY_DAYS)));
  await deleteObjects(oldReplays.map((r) => r.r2Prefix)).catch(() => 0);
  if (oldReplays.length > 0) {
    await db.delete(replays).where(inArray(replays.id, oldReplays.map((r) => r.id)));
  }

  // Source maps of releases older than MAP_DAYS.
  const oldReleases = await db
    .select({ id: releases.id })
    .from(releases)
    .where(lt(releases.createdAt, cutoff(MAP_DAYS)));
  let mapCount = 0;
  if (oldReleases.length > 0) {
    const relIds = oldReleases.map((r) => r.id);
    const arts = await db
      .select({ id: sourceMapArtifacts.id, r2Key: sourceMapArtifacts.r2Key })
      .from(sourceMapArtifacts)
      .where(inArray(sourceMapArtifacts.releaseId, relIds));
    await deleteObjects(arts.map((a) => a.r2Key)).catch(() => 0);
    if (arts.length > 0) {
      await db.delete(sourceMapArtifacts).where(inArray(sourceMapArtifacts.id, arts.map((a) => a.id)));
      mapCount = arts.length;
    }
  }

  // Events + their time-series counts. (Production may DROP old partitions instead.)
  const evRes = await db.delete(events).where(lt(events.timestamp, cutoff(EVENT_DAYS)));
  await db.delete(issueCounts).where(lt(issueCounts.bucket, cutoff(EVENT_DAYS)));

  const evCount = (evRes as unknown as { count?: number }).count ?? 0;
  return { events: evCount, replays: oldReplays.length, maps: mapCount };
}

/** Standalone runner for the `purge` script / manual verification. */
export async function runPurgeOnce(): Promise<void> {
  const res = await purge();
  // eslint-disable-next-line no-console
  console.log(`[retention] purged events=${res.events} replays=${res.replays} maps=${res.maps}`);
  await sql.end();
}
