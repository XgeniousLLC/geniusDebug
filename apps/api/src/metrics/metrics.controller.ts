import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { db, projects, events, replays } from '@geniusdebug/db';
import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { hasProjectAccess } from '../access';

const conn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const ingestQueue = new Queue('ingest', { connection: conn });
const dlq = new Queue('ingest-dead', { connection: conn });

/** Internal observability (NFR-MNT-2) + per-project usage (FR-RET-3). */
@Controller()
@UseGuards(JwtGuard)
export class MetricsController {
  @Get('metrics')
  async metrics(@Req() req: Request & { user?: AuthPrincipal }) {
    // Operational internals (queue depth, latency, drop counters) — admin only.
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const pids = (await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, req.user!.orgId))).map((r) => r.id);

    const [counts, deadCount] = await Promise.all([ingestQueue.getJobCounts(), dlq.getJobCounts()]);

    // Latency samples (worker-written).
    const raw = await conn.lrange('metrics:proc_latency_ms', 0, 199);
    const samples = raw.map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
    const p = (q: number) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] : 0);

    // Aggregate drop counters for today across org projects.
    const day = new Date().toISOString().slice(0, 10);
    const drops: Record<string, number> = {};
    for (const pid of pids) {
      const keys = await conn.keys(`drops:${pid}:*:${day}`);
      for (const k of keys) {
        const reason = k.split(':')[2];
        drops[reason] = (drops[reason] ?? 0) + Number(await conn.get(k));
      }
    }

    return {
      queue: { waiting: counts.waiting ?? 0, active: counts.active ?? 0, failed: counts.failed ?? 0, deadLetter: deadCount.waiting ?? 0 },
      latencyMs: { p50: p(0.5), p95: p(0.95), samples: samples.length },
      dropsToday: drops,
    };
  }

  @Get('projects/:id/usage')
  async usage(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (!(await hasProjectAccess(req.user!, id))) return { perDay: [], replayBytes: 0, totalEvents: 0 };

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const perDay = await db
      .select({ day: dsql<string>`date_trunc('day', ${events.timestamp})::date::text`, count: dsql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.projectId, id), gte(events.timestamp, since)))
      .groupBy(dsql`date_trunc('day', ${events.timestamp})`)
      .orderBy(dsql`date_trunc('day', ${events.timestamp})`);

    const replayAgg = await db
      .select({ bytes: dsql<number>`coalesce(sum(${replays.size}),0)::bigint`, n: dsql<number>`count(*)::int` })
      .from(replays)
      .where(eq(replays.projectId, id));

    const total = await db.select({ c: dsql<number>`count(*)::int` }).from(events).where(eq(events.projectId, id));

    return { perDay, replayBytes: Number(replayAgg[0]?.bytes ?? 0), replayCount: replayAgg[0]?.n ?? 0, totalEvents: total[0]?.c ?? 0 };
  }
}
