import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { db, issues, events, environments, issueActivity, users, issueCounts, replays, repositories, releases } from '@geniusdebug/db';
import { and, eq, ne, desc, asc, ilike, or, inArray, gte, sql } from 'drizzle-orm';
import type { IssueDto, EventDto, IssueListQuery, IssueListResponse, IssueActionInput } from '@geniusdebug/shared';
import type { AuthPrincipal } from '../auth/jwt.guard';
import { accessibleProjectIds } from '../access';
import { GithubService } from '../github/github.service';

@Injectable()
export class IssuesService {
  constructor(private readonly gh: GithubService) {}

  /** Fetch a frame's source from the linked GitHub repo (FR-MAP-6) so the crashing
   *  line can be shown even when the event carried no embedded source context. */
  async sourceForFrame(user: AuthPrincipal, shortId: string, rawPath: string, line: number) {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0) throw new NotFoundException('issue not found');
    const rows = await db
      .select({ projectId: issues.projectId, firstReleaseId: issues.firstReleaseId })
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('issue not found');
    const issue = rows[0];

    const repo = (await db.select().from(repositories).where(eq(repositories.projectId, issue.projectId)).limit(1))[0];
    if (!repo || !repo.installationId) return { available: false, reason: 'no GitHub repo linked' as const };
    const token = await this.gh.installationTokenForOrg(user.orgId, repo.installationId);
    if (!token) return { available: false, reason: 'GitHub auth unavailable' as const };

    let ref = repo.defaultBranch;
    if (issue.firstReleaseId) {
      const rel = (await db.select({ sha: releases.commitSha }).from(releases).where(eq(releases.id, issue.firstReleaseId)).limit(1))[0];
      if (rel?.sha) ref = rel.sha;
    }

    const path = rawPath
      .replace(/^webpack-internal:\/\/\/(\(.*?\)\/)?/, '')
      .replace(/^(https?:\/\/[^/]+\/)?_next\/(app|src)\//, '$2/')
      .replace(/^webpack:\/+/, '')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '');
    if (!path || path.includes('node_modules/')) return { available: false, reason: 'not a repo source file' as const };

    const content = await this.gh.getFileContent(token, repo.owner, repo.name, path, ref);
    if (content == null) return { available: false, reason: 'file not found in repo' as const };

    const all = content.split('\n');
    const start = Math.max(1, line - 8);
    const end = Math.min(all.length, line + 8);
    const lines = [];
    for (let n = start; n <= end; n++) lines.push({ n, text: all[n - 1] ?? '', crash: n === line });
    const githubUrl = `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${path}${line ? `#L${line}` : ''}`;
    return { available: true as const, path, lines, githubUrl };
  }

  /** Resolve the target project among those the caller can access (default = first). */
  private async resolveProject(user: AuthPrincipal, projectId?: string): Promise<string | null> {
    const ids = await accessibleProjectIds(user);
    if (projectId) return ids.includes(projectId) ? projectId : null;
    return ids[0] ?? null;
  }

  async list(user: AuthPrincipal, q: IssueListQuery & { projectId?: string }): Promise<IssueListResponse> {
    const empty = { items: [], total: 0 };
    const projectId = await this.resolveProject(user, q.projectId);
    if (!projectId) return empty;

    const conds = [eq(issues.projectId, projectId)];
    const status = q.status ?? 'unresolved';
    if (status !== 'all') conds.push(eq(issues.status, status));
    if (q.category && q.category !== 'all') conds.push(eq(issues.category, q.category));
    if (q.query) {
      const like = `%${q.query}%`;
      conds.push(or(ilike(issues.title, like), ilike(issues.culprit, like), ilike(issues.shortId, like))!);
    }
    // Time window (FR-UI-2): keep issues seen within the range; 'all'/undefined = no bound.
    const windowMs: Record<string, number> = { '24h': 864e5, '7d': 6048e5, '14d': 12096e5, '30d': 2592e6 };
    if (q.range && q.range !== 'all' && windowMs[q.range]) {
      conds.push(gte(issues.lastSeen, new Date(Date.now() - windowMs[q.range])));
    }
    // Environment filter (FR-UI-2): issues with an event in that environment.
    if (q.environment && q.environment !== 'all') {
      const envRows = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.projectId, projectId), eq(environments.name, q.environment)))
        .limit(1);
      if (envRows.length === 0) return empty;
      const evRows = await db
        .selectDistinct({ issueId: events.issueId })
        .from(events)
        .where(and(eq(events.projectId, projectId), eq(events.environmentId, envRows[0].id)));
      const ids = evRows.map((r) => r.issueId);
      if (ids.length === 0) return empty;
      conds.push(inArray(issues.id, ids));
    }

    const totalRow = await db.select({ c: sql<number>`count(*)::int` }).from(issues).where(and(...conds));
    const total = totalRow[0]?.c ?? 0;

    const order =
      q.sort === 'firstSeen'
        ? desc(issues.firstSeen)
        : q.sort === 'events'
          ? desc(issues.timesSeen)
          : q.sort === 'users'
            ? desc(issues.usersAffected)
            : desc(issues.lastSeen);

    const rows = await db
      .select()
      .from(issues)
      .where(and(...conds))
      .orderBy(order)
      .limit(q.limit ?? 25)
      .offset(q.offset ?? 0);

    if (rows.length === 0) return { items: [], total };
    const issueIds = rows.map((r) => r.id);

    // Sparkline: dense, zero-filled hourly series over the last 24h so the feed
    // graph renders as a proper line chart (not a single dot for sparse issues).
    const SPARK_HOURS = 24;
    const hourMs = 3600_000;
    const nowHour = Math.floor(Date.now() / hourMs);
    const since = new Date((nowHour - (SPARK_HOURS - 1)) * hourMs);
    const countRows = await db
      .select({ issueId: issueCounts.issueId, bucket: issueCounts.bucket, count: issueCounts.count })
      .from(issueCounts)
      .where(and(inArray(issueCounts.issueId, issueIds), gte(issueCounts.bucket, since)))
      .orderBy(asc(issueCounts.bucket));
    const sparkOf = new Map<string, number[]>();
    for (const id of issueIds) sparkOf.set(id, Array(SPARK_HOURS).fill(0));
    for (const c of countRows) {
      const slot = SPARK_HOURS - 1 - (nowHour - Math.floor(new Date(c.bucket).getTime() / hourMs));
      if (slot >= 0 && slot < SPARK_HOURS) sparkOf.get(c.issueId)![slot] += c.count;
    }

    // Assignee display names for the avatars.
    const assigneeIds = [...new Set(rows.map((r) => r.assigneeUserId).filter((x): x is string => !!x))];
    const nameOf = new Map<string, string>();
    if (assigneeIds.length) {
      const us = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, assigneeIds));
      for (const u of us) nameOf.set(u.id, u.name);
    }

    const items = rows.map((r) => ({
      ...this.toDto(r),
      spark: sparkOf.get(r.id) ?? [],
      assigneeName: r.assigneeUserId ? (nameOf.get(r.assigneeUserId) ?? null) : null,
    }));
    return { items, total };
  }

  async detail(user: AuthPrincipal, shortId: string) {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0) throw new NotFoundException('issue not found');

    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('issue not found');
    const issue = rows[0];

    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.issueId, issue.id))
      .orderBy(desc(events.timestamp))
      .limit(50);

    const activity = await db
      .select({
        id: issueActivity.id,
        action: issueActivity.action,
        payload: issueActivity.payload,
        createdAt: issueActivity.createdAt,
        userName: users.name,
      })
      .from(issueActivity)
      .leftJoin(users, eq(users.id, issueActivity.userId))
      .where(eq(issueActivity.issueId, issue.id))
      .orderBy(desc(issueActivity.createdAt));

    const counts = await db
      .select({ bucket: issueCounts.bucket, count: issueCounts.count })
      .from(issueCounts)
      .where(eq(issueCounts.issueId, issue.id))
      .orderBy(asc(issueCounts.bucket));

    return {
      issue: this.toDto(issue),
      latestEvent: evRows[0] ? this.toEventDto(evRows[0]) : null,
      events: evRows.map((e) => this.toEventDto(e)),
      activity,
      counts,
      shareToken: issue.shareToken ?? null,
    };
  }

  /** Replays tied to this issue, collapsed to one row per session (FR-RPL / GD-132). */
  async replaysForIssue(user: AuthPrincipal, shortId: string) {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0) return [];
    const issueRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (issueRows.length === 0) throw new NotFoundException('issue not found');

    const rows = await db
      .select()
      .from(replays)
      .where(eq(replays.issueId, issueRows[0].id))
      .orderBy(desc(replays.createdAt));

    // Collapse many segment rows → one card per replay session.
    const byId = new Map<
      string,
      { id: string; replayId: string | null; durationMs: number | null; segments: number; user: Record<string, unknown> | null; traceId: string | null; createdAt: Date }
    >();
    for (const r of rows) {
      const key = r.replayId ?? r.id;
      const ex = byId.get(key);
      if (ex) {
        ex.segments += 1;
        if ((r.durationMs ?? 0) > (ex.durationMs ?? 0)) ex.durationMs = r.durationMs;
      } else {
        byId.set(key, {
          id: r.id,
          replayId: r.replayId,
          durationMs: r.durationMs,
          segments: 1,
          user: r.user ?? null,
          traceId: r.traceId,
          createdAt: r.createdAt,
        });
      }
    }
    return [...byId.values()];
  }

  /** Toggle a public share link for an issue (GD-133). Returns the token (or null). */
  async setShare(user: AuthPrincipal, shortId: string, enabled: boolean): Promise<{ shareToken: string | null }> {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0) throw new NotFoundException('issue not found');
    const rows = await db
      .select({ id: issues.id, shareToken: issues.shareToken })
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('issue not found');
    const token = enabled ? (rows[0].shareToken ?? randomBytes(18).toString('base64url')) : null;
    await db.update(issues).set({ shareToken: token }).where(eq(issues.id, rows[0].id));
    return { shareToken: token };
  }

  /** Unauthenticated read-only view of a publicly-shared issue (GD-133). */
  async publicIssue(token: string) {
    if (!token) throw new NotFoundException('not found');
    const rows = await db.select().from(issues).where(eq(issues.shareToken, token)).limit(1);
    if (rows.length === 0) throw new NotFoundException('not found');
    const issue = rows[0];
    const ev = await db
      .select()
      .from(events)
      .where(eq(events.issueId, issue.id))
      .orderBy(desc(events.timestamp))
      .limit(1);
    return { issue: this.toDto(issue), latestEvent: ev[0] ? this.toEventDto(ev[0]) : null };
  }

  /** Issues with a similar signature (culprit / type / title overlap) — FR-GRP (GD-132). */
  async similarIssues(user: AuthPrincipal, shortId: string) {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0) return [];
    const selfRows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (selfRows.length === 0) throw new NotFoundException('issue not found');
    const self = selfRows[0];

    const cands = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, self.projectId), ne(issues.id, self.id)))
      .orderBy(desc(issues.lastSeen))
      .limit(200);

    const tokens = (s?: string | null) =>
      new Set((s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    const selfTitle = tokens(self.title);
    const jaccard = (a: Set<string>, b: Set<string>) => {
      if (a.size === 0 || b.size === 0) return 0;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      return inter / (a.size + b.size - inter);
    };

    const scored = cands
      .map((c) => {
        let score = 0;
        if (self.culprit && c.culprit && self.culprit === c.culprit) score += 0.45;
        if (self.type && c.type && self.type === c.type) score += 0.3;
        score += jaccard(selfTitle, tokens(c.title)) * 0.4;
        if (self.level === c.level) score += 0.05;
        return { issue: this.toDto(c), score: Math.min(1, score) };
      })
      .filter((x) => x.score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    return scored;
  }

  async act(user: AuthPrincipal, shortId: string, userId: string, input: IssueActionInput) {
    const projectIds = await accessibleProjectIds(user);
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.shortId, shortId), inArray(issues.projectId, projectIds)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('issue not found');
    const issueId = rows[0].id;

    const patch: Record<string, unknown> = {};
    if (input.action === 'resolve') Object.assign(patch, { status: 'resolved', isRegressed: false });
    else if (input.action === 'unresolve') Object.assign(patch, { status: 'unresolved' });
    else if (input.action === 'archive') Object.assign(patch, { status: 'archived' });
    else if (input.action === 'unarchive') Object.assign(patch, { status: 'unresolved' });
    else if (input.action === 'mute') Object.assign(patch, { status: 'muted' });
    else if (input.action === 'unmute') Object.assign(patch, { status: 'unresolved' });
    else if (input.action === 'assign') Object.assign(patch, { assigneeUserId: input.assigneeUserId ?? null });

    await db.update(issues).set(patch).where(eq(issues.id, issueId));
    await db.insert(issueActivity).values({ issueId, userId, action: input.action, payload: input as Record<string, unknown> });
    return { ok: true };
  }

  /** Permanently delete issues by shortId (GD-149). Events aren't FK-cascaded
   *  (the table is partitioned) so remove them explicitly; the rest cascades. */
  async deleteMany(user: AuthPrincipal, shortIds: string[]): Promise<{ deleted: number }> {
    const projectIds = await accessibleProjectIds(user);
    if (projectIds.length === 0 || shortIds.length === 0) return { deleted: 0 };
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(inArray(issues.shortId, shortIds), inArray(issues.projectId, projectIds)));
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return { deleted: 0 };
    await db.delete(events).where(inArray(events.issueId, ids));
    await db.delete(issues).where(inArray(issues.id, ids));
    return { deleted: ids.length };
  }

  /** Merge `sourceShortId` into `targetShortId` (FR-GRP-6). */
  async merge(user: AuthPrincipal, sourceShortId: string, targetShortId: string, userId: string) {
    const projectIds = await accessibleProjectIds(user);
    const rows = await db
      .select({ id: issues.id, shortId: issues.shortId, timesSeen: issues.timesSeen, usersAffected: issues.usersAffected })
      .from(issues)
      .where(and(inArray(issues.shortId, [sourceShortId, targetShortId]), inArray(issues.projectId, projectIds)));
    const source = rows.find((r) => r.shortId === sourceShortId);
    const target = rows.find((r) => r.shortId === targetShortId);
    if (!source || !target) throw new NotFoundException('issue not found');
    if (source.id === target.id) throw new NotFoundException('cannot merge into itself');

    await db.update(events).set({ issueId: target.id }).where(eq(events.issueId, source.id));
    await db
      .update(issues)
      .set({
        timesSeen: target.timesSeen + source.timesSeen,
        usersAffected: target.usersAffected + source.usersAffected,
      })
      .where(eq(issues.id, target.id));
    await db.insert(issueActivity).values({ issueId: target.id, userId, action: 'merged', payload: { from: sourceShortId } });
    await db.delete(issues).where(eq(issues.id, source.id));
    return { ok: true, into: targetShortId };
  }

  private toDto = (r: typeof issues.$inferSelect): IssueDto => ({
    id: r.id,
    shortId: r.shortId,
    projectId: r.projectId,
    title: r.title,
    culprit: r.culprit,
    type: r.type,
    level: r.level,
    category: r.category,
    status: r.status,
    isRegressed: r.isRegressed,
    assigneeUserId: r.assigneeUserId,
    firstSeen: r.firstSeen.toISOString(),
    lastSeen: r.lastSeen.toISOString(),
    timesSeen: r.timesSeen,
    usersAffected: r.usersAffected,
  });

  private toEventDto = (e: typeof events.$inferSelect): EventDto => ({
    id: e.id,
    issueId: e.issueId,
    timestamp: e.timestamp.toISOString(),
    level: e.level,
    handled: e.handled,
    transaction: e.transaction,
    url: e.url,
    message: e.message,
    release: null,
    environment: '',
    exception: (e.exception as EventDto['exception']) ?? null,
    contexts: (e.contexts as Record<string, unknown>) ?? {},
    request: (e.request as Record<string, unknown>) ?? null,
    user: (e.user as Record<string, unknown>) ?? null,
    tags: (e.tags as Record<string, string>) ?? {},
    breadcrumbs: (e.breadcrumbs as Array<Record<string, unknown>>) ?? [],
    sdk: (e.sdk as Record<string, unknown>) ?? null,
    traceId: e.traceId,
    spanId: e.spanId,
  });
}
