import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { db, traces, spans, events, issues, replays, alertRules, notifications } from '@geniusdebug/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { accessibleProjectIds, assertProjectAccess } from '../access';

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
    return db.select().from(replays).where(inArray(replays.projectId, pids)).orderBy(desc(replays.createdAt)).limit(50);
  }

  @Get('replays/:id')
  async replay(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    const rows = await db.select().from(replays).where(eq(replays.id, id)).limit(1);
    if (!rows[0]) return null;
    await assertProjectAccess(req.user!, rows[0].projectId);
    return rows[0];
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
