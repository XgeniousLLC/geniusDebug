import { Injectable } from '@nestjs/common';
import { connection } from './queue';

/**
 * Per-project fixed-window token bucket in Redis (FR-ING-2). Cheap: one INCR +
 * conditional EXPIRE. Returns remaining/limited so the controller can 429 with
 * Retry-After. A runaway client cannot overwhelm the system or blow up cost.
 */
@Injectable()
export class RateLimitService {
  async check(projectId: string, limitPerMin: number): Promise<{ limited: boolean; retryAfter: number }> {
    const windowSec = 60;
    const bucket = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${projectId}:${bucket}`;
    const count = await connection.incr(key);
    if (count === 1) await connection.expire(key, windowSec);
    if (count > limitPerMin) {
      const ttl = await connection.ttl(key);
      return { limited: true, retryAfter: ttl > 0 ? ttl : windowSec };
    }
    return { limited: false, retryAfter: 0 };
  }
}
