import IORedis from 'ioredis';
import { redisOptions } from '@geniusdebug/shared';

const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const conn = new IORedis(url, redisOptions(url));

/**
 * Increment a daily drop/observability counter in Redis — same key shape as
 * ingest/workers so it surfaces in `/metrics` dropsToday (NFR-MNT-2). Best-effort.
 */
export async function countDrop(projectId: string, reason: string, n = 1): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `drops:${projectId}:${reason}:${day}`;
    const v = await conn.incrby(key, n);
    if (v === n) await conn.expire(key, 60 * 60 * 24 * 8);
  } catch {
    /* observability must never break the request */
  }
}
