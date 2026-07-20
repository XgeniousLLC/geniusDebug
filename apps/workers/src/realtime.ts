import IORedis from 'ioredis';
import { redisOptions } from '@geniusdebug/shared';

/**
 * Realtime fan-out (GD-147): workers publish a tiny "feed changed" signal to a
 * Redis channel; the API relays it to browser EventSource clients so feeds
 * refetch on change instead of polling on a timer.
 */
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const pub = new IORedis(url, redisOptions(url));

export const REALTIME_CHANNEL = 'realtime';

export function publishRealtime(msg: { type: 'issue' | 'replay'; projectId: string; shortId?: string }): void {
  // Best-effort — never let realtime break the pipeline.
  pub.publish(REALTIME_CHANNEL, JSON.stringify(msg)).catch(() => {});
}
