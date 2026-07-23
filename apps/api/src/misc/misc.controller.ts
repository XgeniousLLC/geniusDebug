import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { deepseekJson, deepseekConfigured } from '../suggest/deepseek';
import type { Request } from 'express';
import { db, traces, spans, events, issues, replays, alertRules, notifications, releases, projects, environments } from '@geniusdebug/db';
import { and, desc, eq, gte, lt, inArray, sql } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { accessibleProjectIds, assertProjectAccess } from '../access';
import { getObject } from '../r2';
import { decodeReplayEvents } from './replay-decode';
import { countDrop } from '../drops';

/** Read endpoints backing the Trace / Replay / Alerts pages (FR-TRC/FR-RPL/FR-ALR). */
@Controller()
@UseGuards(JwtGuard)
export class MiscController {

  @Get('traces/:traceId')
  async trace(@Req() req: Request & { user?: AuthPrincipal }, @Param('traceId') traceId: string) {
    const pids = await accessibleProjectIds(req.user!);
    const t = await db.select().from(traces).where(eq(traces.traceId, traceId)).limit(1);
    // Only expose a trace whose project the caller can access.
    if (!t[0] || !pids.includes(t[0].projectId)) return { trace: null, spans: [], errors: [], issues: [] };
    const spanRows = await db.select().from(spans).where(eq(spans.traceId, traceId)).orderBy(spans.startTs);
    const errRows = await db
      .select({
        id: events.id,
        issueId: events.issueId,
        message: events.message,
        level: events.level,
        timestamp: events.timestamp,
        contexts: events.contexts,
        environmentId: events.environmentId,
        transaction: events.transaction,
      })
      .from(events)
      .where(and(eq(events.traceId, traceId), inArray(events.projectId, pids.length ? pids : [''])))
      .orderBy(desc(events.timestamp));
    const issueIds = [...new Set(errRows.map((e) => e.issueId))];
    const relatedIssues = issueIds.length
      ? await db.select({ id: issues.id, shortId: issues.shortId, title: issues.title }).from(issues).where(inArray(issues.id, issueIds))
      : [];
    const titleByIssueId = new Map(relatedIssues.map((i) => [i.id, i.title]));

    // events.message is only populated by SDK captureMessage() calls — most
    // errors are captureException(), which leaves it null. Fall back to the
    // issue title (== exception value/type) so the trace view isn't blank.
    const errs = errRows.map((e) => ({
      id: e.id,
      issueId: e.issueId,
      message: e.message ?? titleByIssueId.get(e.issueId) ?? null,
      level: e.level,
      timestamp: e.timestamp?.toISOString() ?? null,
      transaction: e.transaction ?? null,
    }));

    // Header meta (GD-143): browser/os/env/age/error-count, derived from the error event.
    const lead = errRows[0];
    let envName: string | null = null;
    if (lead?.environmentId) {
      const er = await db.select({ name: environments.name }).from(environments).where(eq(environments.id, lead.environmentId)).limit(1);
      envName = er[0]?.name ?? null;
    }
    const ctx = (lead?.contexts ?? {}) as Record<string, { name?: string; version?: string } | undefined>;
    const nv = (c?: { name?: string; version?: string }) => (c ? [c.name, c.version].filter(Boolean).join(' ') || null : null);
    const meta = {
      platform: t[0].platform,
      browser: nv(ctx.browser),
      os: nv(ctx.os),
      environment: envName,
      errorCount: errs.length,
      leadMessage: lead?.message ?? (lead ? titleByIssueId.get(lead.issueId) : null) ?? null,
      leadTimestamp: lead?.timestamp?.toISOString() ?? null,
      transaction: lead?.transaction ?? t[0].rootTransaction ?? null,
    };
    return { trace: t[0] ?? null, spans: spanRows, errors: errs, issues: relatedIssues, meta };
  }

  @Get('replays')
  async replaysList(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
    @Query('limit') limitQ?: string,
    @Query('offset') offsetQ?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitQ) || 20));
    const offset = Math.max(0, Number(offsetQ) || 0);
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return { items: [], total: 0 };
    // Join the related issue (shortId/title/level) + project name so each replay
    // card can show what error it belongs to and where.
    const rows = await db
      .select({
        id: replays.id,
        projectId: replays.projectId,
        issueId: replays.issueId,
        replayId: replays.replayId,
        segmentId: replays.segmentId,
        traceId: replays.traceId,
        user: replays.user,
        startedAt: replays.startedAt,
        durationMs: replays.durationMs,
        size: replays.size,
        createdAt: replays.createdAt,
        projectName: projects.name,
        issueShortId: issues.shortId,
        issueTitle: issues.title,
        issueLevel: issues.level,
        issueCulprit: issues.culprit,
      })
      .from(replays)
      .leftJoin(issues, eq(issues.id, replays.issueId))
      .leftJoin(projects, eq(projects.id, replays.projectId))
      .where(inArray(replays.projectId, pids))
      .orderBy(desc(replays.createdAt))
      .limit(2000);
    // One card per session: collapse segments of a replayId to their earliest row
    // (segment 0) and sum sizes/segments. Legacy rows (no replayId) pass through.
    const seen = new Set<string>();
    const out: ((typeof rows)[number] & { segmentCount: number })[] = [];
    for (const r of rows) {
      if (!r.replayId) {
        out.push({ ...r, segmentCount: 1 });
        continue;
      }
      if (seen.has(r.replayId)) continue;
      seen.add(r.replayId);
      const segs = rows.filter((x) => x.replayId === r.replayId);
      const first = segs.reduce((a, b) => (a.segmentId <= b.segmentId ? a : b));
      out.push({
        ...first,
        segmentCount: segs.length,
        size: segs.reduce((s, x) => s + (x.size ?? 0), 0),
      });
    }
    return { items: out.slice(offset, offset + limit), total: out.length };
  }

  @Get('replays/:id')
  async replay(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    const rows = await db.select().from(replays).where(eq(replays.id, id)).limit(1);
    if (!rows[0]) return null;
    await assertProjectAccess(req.user!, rows[0].projectId);
    return rows[0];
  }

  /**
   * rrweb events for DOM playback (FR-RPL-5/6). Assembles ALL segments of the
   * session (same replayId) in segment order, decoding each R2 blob and
   * concatenating — a replay is split across many `replay_recording` items.
   */
  @Get('replays/:id/recording')
  async recording(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    const row = (await db.select().from(replays).where(eq(replays.id, id)).limit(1))[0];
    if (!row) return { events: [], reason: 'not found' };
    await assertProjectAccess(req.user!, row.projectId);

    // Gather every segment of this session (or just this row if no replayId).
    const segs = row.replayId
      ? await db
          .select()
          .from(replays)
          .where(and(eq(replays.replayId, row.replayId), eq(replays.projectId, row.projectId)))
          .orderBy(replays.segmentId)
      : [row];

    const events: unknown[] = [];
    let fetched = 0;
    for (const s of segs) {
      if (!s.r2Prefix) continue;
      // Try the stored r2Prefix first; if it doesn't start with 'blobs/' (fallback
      // path from when R2 wasn't configured), also try the canonical blobs/ key.
      const keysToTry = [s.r2Prefix];
      if (!s.r2Prefix.startsWith('blobs/') && s.replayId) {
        keysToTry.push(`blobs/${s.projectId}/${s.replayId}/${s.segmentId ?? 0}-replay_recording`);
      }
      let blob: Buffer | null = null;
      for (const key of keysToTry) {
        blob = await getObject(key);
        if (blob) break;
      }
      if (!blob) continue;
      const decoded = decodeReplayEvents(blob);
      if (decoded.length) {
        events.push(...decoded);
        fetched++;
      }
    }
    if (events.length === 0) {
      const hasPrefix = segs.some((s) => s.r2Prefix);
      // Observability (NFR-MNT-2): a blob existed but nothing decoded → count it.
      if (hasPrefix) await countDrop(row.projectId, 'replay_decode_failed');
      return { events: [], reason: hasPrefix ? 'blob unavailable (R2 unconfigured, wrong encryption key, or decode failed)' : 'no recording blob in R2' };
    }
    return { events, segments: fetched };
  }

  /** AI session summary for a replay (GD-145) — narrative + steps via DeepSeek. */
  @Post('replays/summary')
  async replaySummary(@Body() body: { lines?: string[] }) {
    const lines = (body.lines ?? []).slice(0, 120);
    if (lines.length === 0) return { summary: null, steps: [], reason: 'no activity' };
    if (!(await deepseekConfigured())) return { summary: null, steps: [], reason: 'DeepSeek not configured' };
    const system =
      'You summarize a web session replay for a developer. Given a timestamped activity log ' +
      '(navigation, clicks, console, network, web-vitals, errors), produce a concise narrative and key steps. ' +
      'Return JSON: {"summary": string (1-2 sentences), "steps": [{"time": string, "text": string}] (3-6 items)}.';
    const res = await deepseekJson<{ summary: string; steps: { time: string; text: string }[] }>(
      system,
      `Activity log:\n${lines.join('\n')}`,
    );
    if (!res.ok || !res.data) return { summary: null, steps: [], reason: res.reason ?? 'AI failed' };
    return { summary: res.data.summary, steps: res.data.steps ?? [] };
  }

  /**
   * Performance explorer (GD-150): range-scoped latency percentiles, p75-over-time,
   * per-op "where time is spent" (total time + p50/p75/p90/p95), and slowest spans.
   */
  @Get('performance')
  async performance(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
    @Query('range') range?: string,
    @Query('slowLimit') slowLimit?: string,
  ) {
    const slowN = Math.min(1000, Math.max(10, Number(slowLimit) || 10));
    const access = await accessibleProjectIds(req.user!);
    // Narrow to the switcher-selected project when the caller can access it.
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    const empty = {
      range: range ?? '24h',
      totals: { p50: 0, p75: 0, p95: 0, slowestMs: 0, slowestLabel: null as string | null, samples: 0, ops: 0 },
      overTime: [] as { t: string; p75: number }[],
      overTimeDeltaPct: 0,
      byOp: [] as unknown[],
      hiddenOps: 0,
      slowest: [] as unknown[],
      slowestTotal: 0,
    };
    if (pids.length === 0) return empty;

    const WINDOW: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 604800e3 };
    const windowMs = WINDOW[range ?? '24h'] ?? WINDOW['24h'];
    const nowMs = Date.now();
    const since = new Date(nowMs - windowMs);
    const priorSince = new Date(nowMs - 2 * windowMs);
    const bucketMs = windowMs / 24;

    const dur = spans.durationMs;
    const pct = (q: number) => sql<number>`round(percentile_cont(${q}) within group (order by ${dur}))::int`;
    const inWindow = and(inArray(traces.projectId, pids), gte(spans.startTs, since));

    const [totalsRow, priorRow, byOpRaw, slowest, slowestCountRow, buckets] = await Promise.all([
      db
        .select({ p50: pct(0.5), p75: pct(0.75), p95: pct(0.95), samples: sql<number>`count(*)::int`, ops: sql<number>`count(distinct ${spans.op})::int` })
        .from(spans)
        .innerJoin(traces, eq(traces.traceId, spans.traceId))
        .where(inWindow),
      db
        .select({ p75: pct(0.75) })
        .from(spans)
        .innerJoin(traces, eq(traces.traceId, spans.traceId))
        .where(and(inArray(traces.projectId, pids), gte(spans.startTs, priorSince), lt(spans.startTs, since))),
      db
        .select({
          op: spans.op,
          count: sql<number>`count(*)::int`,
          totalMs: sql<number>`round(sum(${dur}))::int`,
          p50: pct(0.5),
          p75: pct(0.75),
          p90: pct(0.9),
          p95: pct(0.95),
        })
        .from(spans)
        .innerJoin(traces, eq(traces.traceId, spans.traceId))
        .where(inWindow)
        .groupBy(spans.op)
        .orderBy(sql`sum(${dur}) desc nulls last`),
      db
        .select({
          spanId: spans.id,
          op: spans.op,
          description: spans.description,
          durationMs: spans.durationMs,
          status: spans.status,
          traceId: spans.traceId,
          transaction: traces.rootTransaction,
        })
        .from(spans)
        .innerJoin(traces, eq(traces.traceId, spans.traceId))
        .where(inWindow)
        .orderBy(desc(spans.durationMs))
        .limit(slowN),
      db.select({ c: sql<number>`count(*)::int` }).from(spans).innerJoin(traces, eq(traces.traceId, spans.traceId)).where(inWindow),
      db
        .select({ b: sql<number>`floor(extract(epoch from ${spans.startTs}) * 1000 / ${bucketMs})`, p75: pct(0.75) })
        .from(spans)
        .innerJoin(traces, eq(traces.traceId, spans.traceId))
        .where(inWindow)
        .groupBy(sql`1`),
    ]);

    const totals = totalsRow[0] ?? { p50: 0, p75: 0, p95: 0, samples: 0, ops: 0 };
    const slowestSpan = slowest[0];
    const grand = byOpRaw.reduce((s, o) => s + (o.totalMs ?? 0), 0) || 1;
    const byOp = byOpRaw.map((o) => ({ ...o, pctOfTotal: Math.round(((o.totalMs ?? 0) / grand) * 100) }));

    // 24 buckets ending "now"; fill p75 by absolute bucket number.
    const p75ByBucket = new Map<number, number>();
    for (const r of buckets) p75ByBucket.set(Number(r.b), r.p75 ?? 0);
    const nowBucket = Math.floor(nowMs / bucketMs);
    const overTime = Array.from({ length: 24 }, (_, i) => {
      const bucketNo = nowBucket - 23 + i;
      return { t: new Date(bucketNo * bucketMs).toISOString(), p75: p75ByBucket.get(bucketNo) ?? 0 };
    });

    const curP75 = totals.p75 ?? 0;
    const priorP75 = priorRow[0]?.p75 ?? 0;
    const overTimeDeltaPct = priorP75 > 0 ? Math.round(((curP75 - priorP75) / priorP75) * 100) : 0;

    return {
      range: range ?? '24h',
      totals: {
        p50: totals.p50 ?? 0,
        p75: curP75,
        p95: totals.p95 ?? 0,
        slowestMs: slowestSpan?.durationMs ?? 0,
        slowestLabel: slowestSpan ? [slowestSpan.op, slowestSpan.description ?? slowestSpan.transaction].filter(Boolean).join(' ') : null,
        samples: totals.samples ?? 0,
        ops: totals.ops ?? 0,
      },
      overTime,
      overTimeDeltaPct,
      byOp,
      hiddenOps: Math.max(0, byOp.length - 10),
      slowest,
      slowestTotal: slowestCountRow[0]?.c ?? 0,
    };
  }

  /** Releases across accessible projects with new-issue counts (GD-135). */
  @Get('releases')
  async releasesList(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
    @Query('limit') limitQ?: string,
    @Query('offset') offsetQ?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitQ) || 20));
    const offset = Math.max(0, Number(offsetQ) || 0);
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return { items: [], total: 0 };
    const totalRow = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(releases)
      .where(inArray(releases.projectId, pids));
    const rows = await db
      .select({
        id: releases.id,
        version: releases.version,
        commitSha: releases.commitSha,
        createdAt: releases.createdAt,
        projectId: releases.projectId,
        projectName: projects.name,
        newIssues: sql<number>`count(distinct ${issues.id})::int`,
      })
      .from(releases)
      .leftJoin(projects, eq(projects.id, releases.projectId))
      .leftJoin(issues, eq(issues.firstReleaseId, releases.id))
      .where(inArray(releases.projectId, pids))
      .groupBy(releases.id, projects.name)
      .orderBy(desc(releases.createdAt))
      .limit(limit)
      .offset(offset);
    return { items: rows, total: totalRow[0]?.c ?? 0 };
  }

  @Get('alerts')
  async alertsList(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
  ) {
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return [];
    return db.select().from(alertRules).where(inArray(alertRules.projectId, pids));
  }

  @Get('alerts/history')
  async alertsHistory(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
    @Query('limit') limitQ?: string,
    @Query('offset') offsetQ?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitQ) || 20));
    const offset = Math.max(0, Number(offsetQ) || 0);
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return [];
    return db
      .select()
      .from(notifications)
      .where(inArray(notifications.projectId, pids))
      .orderBy(desc(notifications.sentAt))
      .limit(limit)
      .offset(offset);
  }
}
