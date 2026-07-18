import IORedis from 'ioredis';
import { redisOptions } from '@geniusdebug/shared';

const conn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', redisOptions());

/** Aggregate counters + latency samples in Redis (NFR-MNT-2, FR-ING-6). */
export async function countDrop(projectId: string, reason: string, n = 1): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `drops:${projectId}:${reason}:${day}`;
  const v = await conn.incrby(key, n);
  if (v === n) await conn.expire(key, 60 * 60 * 24 * 8);
}

/** Rolling processing-latency samples (last 200) for the metrics endpoint. */
export async function recordLatency(ms: number): Promise<void> {
  await conn.lpush('metrics:proc_latency_ms', ms);
  await conn.ltrim('metrics:proc_latency_ms', 0, 199);
}

/** Close the Redis handle (tests / graceful shutdown). */
export async function closeMetrics(): Promise<void> {
  await conn.quit();
}
