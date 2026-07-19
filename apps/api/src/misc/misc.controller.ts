import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { db, traces, spans, events, issues, replays, alertRules, notifications } from '@geniusdebug/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
  async replaysList(@Req() req: Request & { user?: AuthPrincipal }) {
    const pids = await accessibleProjectIds(req.user!);
    if (pids.length === 0) return [];
    const rows = await db
      .select()
      .from(replays)
      .where(inArray(replays.projectId, pids))
      .orderBy(desc(replays.createdAt))
      .limit(200);
    // One card per session: collapse segments of a replayId to their earliest row
    // (segment 0) and sum sizes/segments. Legacy rows (no replayId) pass through.
    const seen = new Set<string>();
    const out: (typeof rows)[number][] = [];
    for (const r of rows) {
      if (!r.replayId) {
        out.push(r);
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
      if (!s.r2Prefix || !s.r2Prefix.startsWith('blobs/')) continue;
      const blob = await getObject(s.r2Prefix);
      if (!blob) continue;
      const decoded = decodeReplayEvents(blob);
      if (decoded.length) {
        events.push(...decoded);
        fetched++;
      }
    }
    if (events.length === 0) {
      // Observability (NFR-MNT-2): a blob existed but nothing decoded → count it.
      if (segs.some((s) => s.r2Prefix?.startsWith('blobs/'))) await countDrop(row.projectId, 'replay_decode_failed');
      return { events: [], reason: segs.some((s) => s.r2Prefix?.startsWith('blobs/')) ? 'blob unavailable (R2 unconfigured or missing)' : 'no recording blob in R2' };
    }
    return { events, segments: fetched };
  }

  @Get('alerts')
  async alertsList(@Req() req: Request & { user?: AuthPrincipal }) {
    const pids = await accessibleProjectIds(req.user!);
    if (pids.length === 0) return [];
    return db.select().from(alertRules).where(inArray(alertRules.projectId, pids));
  }

  @Get('alerts/history')
  async alertsHistory(@Req() req: Request & { user?: AuthPrincipal }) {
    const pids = await accessibleProjectIds(req.user!);
    if (pids.length === 0) return [];
    return db.select().from(notifications).where(inArray(notifications.projectId, pids)).orderBy(desc(notifications.sentAt)).limit(50);
  }
}
