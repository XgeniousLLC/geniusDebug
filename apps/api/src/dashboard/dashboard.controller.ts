import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import IORedis from 'ioredis';
import { db, projects, events, issues, memberships, users } from '@geniusdebug/db';
import { and, eq, gte, inArray, desc, sql as dsql } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { accessibleProjectIds } from '../access';
import { redisOptions } from '@geniusdebug/shared';

const conn = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', redisOptions());

/**
 * Org dashboard aggregate (single round-trip for the overview page): totals,
 * most-frequent issues, per-project rollup, members, processing performance and
 * the hour-of-day activity histogram ("when were users most active").
 */
@Controller('dashboard')
@UseGuards(JwtGuard)
export class DashboardController {
  @Get()
  async overview(@Req() req: Request & { user?: AuthPrincipal }) {
    const orgId = req.user!.orgId;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Scope to projects the caller can access (members: granted only).
    const accessIds = await accessibleProjectIds(req.user!);
    const projRows = accessIds.length
      ? await db
          .select({ id: projects.id, name: projects.name, platform: projects.platform, ingestEnabled: projects.ingestEnabled })
          .from(projects)
          .where(inArray(projects.id, accessIds))
      : [];
    const pids = projRows.map((p) => p.id);
    const nameOf = new Map(projRows.map((p) => [p.id, p.name]));

    const members = await db
      .select({ name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId));

    // No projects yet → return an empty-but-valid shape.
    if (pids.length === 0) {
      return {
        totals: { projects: 0, members: members.length, unresolvedIssues: 0, events7d: 0, eventsTotal: 0, activeUsers7d: 0 },
        topIssues: [],
        projects: [],
        members,
        performance: { p50: 0, p95: 0, samples: 0 },
        activityByHour: Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0 })),
        peakHour: null,
      };
    }

    const [
      unresolvedAgg,
      events7dAgg,
      eventsTotalAgg,
      activeUsersAgg,
      topIssues,
      eventsByProject,
      issuesByProject,
      byHour,
    ] = await Promise.all([
      db.select({ c: dsql<number>`count(*)::int` }).from(issues).where(and(inArray(issues.projectId, pids), eq(issues.status, 'unresolved'))),
      db.select({ c: dsql<number>`count(*)::int` }).from(events).where(and(inArray(events.projectId, pids), gte(events.timestamp, since))),
      db.select({ c: dsql<number>`count(*)::int` }).from(events).where(inArray(events.projectId, pids)),
      db
        .select({ c: dsql<number>`count(distinct ${events.user}->>'id')::int` })
        .from(events)
        .where(and(inArray(events.projectId, pids), gte(events.timestamp, since))),
      db
        .select({
          shortId: issues.shortId,
          title: issues.title,
          culprit: issues.culprit,
          level: issues.level,
          status: issues.status,
          timesSeen: issues.timesSeen,
          usersAffected: issues.usersAffected,
          lastSeen: issues.lastSeen,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(inArray(issues.projectId, pids))
        .orderBy(desc(issues.timesSeen))
        .limit(6),
      db
        .select({ projectId: events.projectId, n: dsql<number>`count(*)::int` })
        .from(events)
        .where(and(inArray(events.projectId, pids), gte(events.timestamp, since)))
        .groupBy(events.projectId),
      db
        .select({ projectId: issues.projectId, n: dsql<number>`count(*)::int` })
        .from(issues)
        .where(and(inArray(issues.projectId, pids), eq(issues.status, 'unresolved')))
        .groupBy(issues.projectId),
      db
        .select({ hour: dsql<number>`extract(hour from ${events.timestamp})::int`, n: dsql<number>`count(*)::int` })
        .from(events)
        .where(and(inArray(events.projectId, pids), gte(events.timestamp, since)))
        .groupBy(dsql`extract(hour from ${events.timestamp})`),
    ]);

    const evByProj = new Map(eventsByProject.map((r) => [r.projectId, r.n]));
    const isByProj = new Map(issuesByProject.map((r) => [r.projectId, r.n]));
    const projectRollup = projRows
      .map((p) => ({
        id: p.id,
        name: p.name,
        platform: p.platform,
        ingestEnabled: p.ingestEnabled,
        events7d: evByProj.get(p.id) ?? 0,
        unresolvedIssues: isByProj.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.events7d - a.events7d);

    const activityByHour = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      events: byHour.find((r) => r.hour === hour)?.n ?? 0,
    }));
    const peak = activityByHour.reduce((m, h) => (h.events > m.events ? h : m), activityByHour[0]);
    const peakHour = peak.events > 0 ? peak.hour : null;

    // Processing latency percentiles (worker-written samples).
    let performance = { p50: 0, p95: 0, samples: 0 };
    try {
      const raw = await conn.lrange('metrics:proc_latency_ms', 0, 199);
      const s = raw.map(Number).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
      const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
      performance = { p50: p(0.5), p95: p(0.95), samples: s.length };
    } catch {
      /* redis optional */
    }

    return {
      totals: {
        projects: projRows.length,
        members: members.length,
        unresolvedIssues: unresolvedAgg[0]?.c ?? 0,
        events7d: events7dAgg[0]?.c ?? 0,
        eventsTotal: eventsTotalAgg[0]?.c ?? 0,
        activeUsers7d: activeUsersAgg[0]?.c ?? 0,
      },
      topIssues: topIssues.map((i) => ({ ...i, projectName: nameOf.get(i.projectId) ?? '—' })),
      projects: projectRollup,
      members,
      performance,
      activityByHour,
      peakHour,
    };
  }
}
