import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { deepseekJson, deepseekConfigured } from '../suggest/deepseek';
import type { Request } from 'express';
import { db, traces, spans, events, issues, replays, alertRules, notifications, releases, projects } from '@geniusdebug/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
    const errs = await db
      .select({ id: events.id, issueId: events.issueId, message: events.message, level: events.level })
      .from(events)
      .where(and(eq(events.traceId, traceId), inArray(events.projectId, pids.length ? pids : [''])));
    const issueIds = [...new Set(errs.map((e) => e.issueId))];
    const relatedIssues = issueIds.length
      ? await db.select({ id: issues.id, shortId: issues.shortId, title: issues.title }).from(issues).where(inArray(issues.id, issueIds))
      : [];
    return { trace: t[0] ?? null, spans: spanRows, errors: errs, issues: relatedIssues };
  }

  @Get('replays')
  async replaysList(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
  ) {
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return [];
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
      .limit(200);
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
    return out.slice(0, 50);
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

  /** Performance explorer (GD-136): worst spans + per-op p75, scoped to access. */
  @Get('performance')
  async performance(
    @Req() req: Request & { user?: AuthPrincipal },
    @Query('projectId') projectId?: string,
  ) {
    const access = await accessibleProjectIds(req.user!);
    // Narrow to the switcher-selected project when the caller can access it.
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return { samples: [], byOp: [] };

    // Slowest individual spans (samples table), joined to their trace/transaction.
    const samples = await db
      .select({
        spanId: spans.id,
        op: spans.op,
        description: spans.description,
        durationMs: spans.durationMs,
        status: spans.status,
        traceId: spans.traceId,
        transaction: traces.rootTransaction,
        startTs: spans.startTs,
      })
      .from(spans)
      .innerJoin(traces, eq(traces.traceId, spans.traceId))
      .where(inArray(traces.projectId, pids))
      .orderBy(desc(spans.durationMs))
      .limit(50);

    // Per-op aggregates: count + avg + p75 duration.
    const byOp = await db
      .select({
        op: spans.op,
        count: sql<number>`count(*)::int`,
        avgMs: sql<number>`round(avg(${spans.durationMs}))::int`,
        p75Ms: sql<number>`round(percentile_cont(0.75) within group (order by ${spans.durationMs}))::int`,
        maxMs: sql<number>`max(${spans.durationMs})::int`,
      })
      .from(spans)
      .innerJoin(traces, eq(traces.traceId, spans.traceId))
      .where(inArray(traces.projectId, pids))
      .groupBy(spans.op)
      .orderBy(sql`percentile_cont(0.75) within group (order by ${spans.durationMs}) desc nulls last`)
      .limit(30);

    return { samples, byOp };
  }

  /** Releases across accessible projects with new-issue counts (GD-135). */
  @Get('releases')
  async releasesList(@Req() req: Request & { user?: AuthPrincipal }) {
    const pids = await accessibleProjectIds(req.user!);
    if (pids.length === 0) return [];
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
      .limit(50);
    return rows;
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
  ) {
    const access = await accessibleProjectIds(req.user!);
    const pids = projectId && access.includes(projectId) ? [projectId] : access;
    if (pids.length === 0) return [];
    return db.select().from(notifications).where(inArray(notifications.projectId, pids)).orderBy(desc(notifications.sentAt)).limit(50);
  }
}
