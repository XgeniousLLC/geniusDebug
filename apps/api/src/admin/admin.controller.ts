import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, repositories, releases, orgTokens, sourceMapArtifacts, projects, users, memberships, dsnKeys, projectMembers, getActiveIntegration, issues, events, replays } from '@geniusdebug/db';
import { decrypt, computeCulprit } from '@geniusdebug/shared';
import type { NormalizedFrame } from '@geniusdebug/shared';
import { and, eq, ne, inArray, desc, isNull } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { sendEmail } from '../mailer';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5199';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Invite acceptance link (7-day reset token → /reset). */
function inviteLink(email: string, token: string): string {
  return `${WEB_URL}/reset?token=${token}&email=${encodeURIComponent(email)}`;
}

/** Invite email body — shared by invite + reinvite (FR-ADM-6). */
function buildInviteEmail(fromEmail: string | undefined, role: string, toEmail: string, token: string): string {
  const link = inviteLink(toEmail, token);
  return `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto">
      <h2 style="margin:0 0 12px">You've been invited to geniusDebug</h2>
      <p>${escapeHtml(fromEmail ?? 'An admin')} added you to their geniusDebug workspace as
         <strong>${escapeHtml(role)}</strong>.</p>
      <p>Set your password to accept the invite and sign in:</p>
      <p><a href="${link}" style="display:inline-block;background:#6d5efc;color:#fff;
         padding:10px 18px;border-radius:8px;text-decoration:none">Accept invite &amp; set password</a></p>
      <p style="color:#666;font-size:13px">Or paste this link (valid 7 days):<br>${link}</p>
    </div>`;
}

/**
 * Admin + deploy-pipeline endpoints (FR-GH-1, FR-ADM-5, FR-BLD-2 / §4.3).
 * Repo linking + token issuance are admin-only (JWT). Artifact registration uses
 * the SECRET org upload token (not the public DSN, NFR-SEC-2).
 */
@Controller()
export class AdminController {
  private async assertProjectInOrg(orgId: string, projectId: string) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (rows.length === 0) throw new ForbiddenException('project not in org');
  }

  /* --------------------------- GitHub repo link (FR-GH-1) ------------------ */
  @Get('projects/:id/repository')
  @UseGuards(JwtGuard)
  async getRepo(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    await this.assertProjectInOrg(req.user!.orgId, id);
    const rows = await db
      .select({ owner: repositories.owner, name: repositories.name, defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(eq(repositories.projectId, id))
      .limit(1);
    return rows[0] ?? null;
  }

  @Post('projects/:id/repository')
  @UseGuards(JwtGuard)
  async linkRepo(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { owner?: string; name?: string; defaultBranch?: string; releaseVersion?: string; commitSha?: string },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertProjectInOrg(req.user!.orgId, id);
    if (!body.owner || !body.name) throw new BadRequestException('owner and name required');

    // One repo per project (v1). Replace on re-link.
    await db.delete(repositories).where(eq(repositories.projectId, id));
    const repo = await db
      .insert(repositories)
      .values({
        projectId: id,
        provider: 'github',
        owner: body.owner,
        name: body.name,
        defaultBranch: body.defaultBranch || 'main',
        connectedByUserId: req.user!.userId,
      })
      .returning({ id: repositories.id });

    // Optionally stamp a release's commit so frames deep-link to the exact SHA (FR-GH-2/3).
    if (body.releaseVersion && body.commitSha) {
      await db
        .update(releases)
        .set({ commitSha: body.commitSha, repositoryId: repo[0].id })
        .where(and(eq(releases.projectId, id), eq(releases.version, body.releaseVersion)));
    }
    return { ok: true, repositoryId: repo[0].id };
  }

  /* ---------------- Remote kill switch (FR-SDK-8 / NFR-PERF-4) -------------- */
  @Post('projects/:id/ingest')
  @UseGuards(JwtGuard)
  async setIngest(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertProjectInOrg(req.user!.orgId, id);
    await db.update(projects).set({ ingestEnabled: body.enabled !== false }).where(eq(projects.id, id));
    return { ok: true, ingestEnabled: body.enabled !== false };
  }

  /* --------------------- DSN key regenerate / revoke (FR-ADM-5) ------------ */
  @Post('projects/:id/keys/regenerate')
  @UseGuards(JwtGuard)
  async regenerateKey(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertProjectInOrg(req.user!.orgId, id);
    // Revoke current active keys, mint a fresh one.
    await db.update(dsnKeys).set({ isActive: false, revokedAt: new Date() }).where(and(eq(dsnKeys.projectId, id), eq(dsnKeys.isActive, true)));
    const publicKey = randomBytes(16).toString('hex');
    await db.insert(dsnKeys).values({ projectId: id, publicKey, rateLimit: 3000 });
    return { ok: true, publicKey };
  }

  @Post('keys/:publicKey/revoke')
  @UseGuards(JwtGuard)
  async revokeKey(@Req() req: Request & { user?: AuthPrincipal }, @Param('publicKey') publicKey: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    // Ensure the key belongs to a project in the caller's org.
    const rows = await db
      .select({ projectId: dsnKeys.projectId })
      .from(dsnKeys)
      .innerJoin(projects, eq(projects.id, dsnKeys.projectId))
      .where(and(eq(dsnKeys.publicKey, publicKey), eq(projects.orgId, req.user!.orgId)))
      .limit(1);
    if (rows.length === 0) throw new ForbiddenException('key not in org');
    await db.update(dsnKeys).set({ isActive: false, revokedAt: new Date() }).where(eq(dsnKeys.publicKey, publicKey));
    return { ok: true };
  }

  /* ------------------------ Secret upload token (FR-ADM-5) ----------------- */
  @Post('projects/:id/upload-token')
  @UseGuards(JwtGuard)
  async issueToken(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertProjectInOrg(req.user!.orgId, id);
    const token = `gdo_${randomBytes(24).toString('hex')}`;
    const tokenHash = await bcrypt.hash(token, 10);
    await db.insert(orgTokens).values({ orgId: req.user!.orgId, tokenHash, scope: 'source-map-upload' });
    // Shown ONCE — never stored in plaintext (NFR-SEC-2/5).
    return { token };
  }

  /* --------------------------- Members (FR-ADM-6) -------------------------- */
  @Get('members')
  @UseGuards(JwtGuard)
  async listMembers(@Req() req: Request & { user?: AuthPrincipal }) {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: memberships.role,
        // Invited-but-not-accepted: still holds a live reset token (set at invite,
        // cleared when they set a password). FR-ADM-6.
        resetTokenHash: users.resetTokenHash,
        resetExpires: users.resetExpires,
        invitedAt: users.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, req.user!.orgId));
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      pending: r.resetTokenHash != null && !!r.resetExpires && r.resetExpires.getTime() > now,
      invitedAt: r.invitedAt,
    }));
  }

  @Post('members')
  @UseGuards(JwtGuard)
  async invite(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name?: string; email?: string; role?: 'admin' | 'member'; projectIds?: string[] },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    if (!body.email || !body.name) throw new BadRequestException('name and email required');
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) throw new BadRequestException('email already a member');
    // Create the user with an unusable random password; they set their own via the
    // invite link (same reset-token machinery as forgot-password).
    const tempHash = await bcrypt.hash(`temp_${randomBytes(12).toString('hex')}`, 10);
    // Invite token → user picks a password on the /reset page. 7-day window.
    const token = randomBytes(24).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const u = await db
      .insert(users)
      .values({
        orgId: req.user!.orgId,
        email: body.email,
        name: body.name,
        passwordHash: tempHash,
        resetTokenHash: tokenHash,
        resetExpires: expires,
      })
      .returning({ id: users.id });
    await db.insert(memberships).values({ orgId: req.user!.orgId, userId: u[0].id, role: body.role ?? 'member' });

    // Invitations are project-scoped: auto-grant access to the project(s) the
    // invite was issued from (NFR-SEC-6). Only projects in the admin's org.
    const wanted = (body.projectIds ?? []).filter((x): x is string => typeof x === 'string');
    if (wanted.length > 0) {
      const owned = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.orgId, req.user!.orgId), inArray(projects.id, wanted)));
      if (owned.length > 0) {
        await db.insert(projectMembers).values(owned.map((p) => ({ projectId: p.id, userId: u[0].id }))).onConflictDoNothing();
      }
    }

    const html = buildInviteEmail(req.user!.email, body.role ?? 'member', body.email, token);
    const link = inviteLink(body.email, token);
    const mail = await sendEmail([body.email], "You've been invited to geniusDebug", html, req.user!.orgId);
    // eslint-disable-next-line no-console
    if (!mail.sent) console.log(`[admin] invite link for ${body.email}: ${link}`);
    // In dev / when SES is unset, hand the link back so the admin can share it manually.
    return { ok: true, id: u[0].id, emailSent: mail.sent, inviteLink: mail.sent ? undefined : link, reason: mail.reason };
  }

  /**
   * Re-send an invite to a pending member: mint a fresh 7-day token and email it
   * again (or hand the link back when SES is unset). Admin-only. FR-ADM-6.
   */
  @Post('members/:id/reinvite')
  @UseGuards(JwtGuard)
  async reinvite(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const rows = await db
      .select({ email: users.email, role: memberships.role })
      .from(users)
      .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, req.user!.orgId)))
      .where(and(eq(users.id, id), eq(users.orgId, req.user!.orgId)))
      .limit(1);
    if (rows.length === 0) throw new BadRequestException('member not found');
    const { email, role } = rows[0];

    const token = randomBytes(24).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.update(users).set({ resetTokenHash: tokenHash, resetExpires: expires }).where(eq(users.id, id));

    const html = buildInviteEmail(req.user!.email, role, email, token);
    const link = inviteLink(email, token);
    const mail = await sendEmail([email], "You've been invited to geniusDebug", html, req.user!.orgId);
    // eslint-disable-next-line no-console
    if (!mail.sent) console.log(`[admin] re-invite link for ${email}: ${link}`);
    return { ok: true, emailSent: mail.sent, inviteLink: mail.sent ? undefined : link, reason: mail.reason };
  }

  @Post('members/:id/role')
  @UseGuards(JwtGuard)
  async setRole(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { role?: 'admin' | 'member' },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    if (id === req.user!.userId) throw new BadRequestException('cannot change your own role');
    await db
      .update(memberships)
      .set({ role: body.role ?? 'member' })
      .where(and(eq(memberships.orgId, req.user!.orgId), eq(memberships.userId, id)));
    return { ok: true };
  }

  @Post('members/:id/remove')
  @UseGuards(JwtGuard)
  async removeMember(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    if (id === req.user!.userId) throw new BadRequestException('cannot remove yourself');
    await db.delete(memberships).where(and(eq(memberships.orgId, req.user!.orgId), eq(memberships.userId, id)));
    await db.delete(users).where(and(eq(users.id, id), eq(users.orgId, req.user!.orgId), ne(users.id, req.user!.userId)));
    return { ok: true };
  }

  /** Project-access grants for a member (NFR-SEC-6). Admin-only. */
  @Get('members/:id/projects')
  @UseGuards(JwtGuard)
  async getMemberProjects(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const rows = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, id), eq(projects.orgId, req.user!.orgId)));
    return { projectIds: rows.map((r) => r.projectId) };
  }

  @Post('members/:id/projects')
  @UseGuards(JwtGuard)
  async setMemberProjects(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { projectIds?: string[] },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const orgId = req.user!.orgId;
    // Target must be a member of this org.
    const mem = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, id))).limit(1);
    if (mem.length === 0) throw new BadRequestException('not a member of this org');

    // Keep only ids that are real projects in this org.
    const orgProjectIds = new Set((await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId))).map((r) => r.id));
    const wanted = [...new Set(body.projectIds ?? [])].filter((pid) => orgProjectIds.has(pid));

    await db.transaction(async (tx) => {
      await tx.delete(projectMembers).where(eq(projectMembers.userId, id));
      if (wanted.length > 0) {
        await tx.insert(projectMembers).values(wanted.map((projectId) => ({ projectId, userId: id })));
      }
    });
    return { ok: true, projectIds: wanted };
  }

  /**
   * One-time backfill (FR-GRP-3): `issues.culprit` used to be frozen at the raw,
   * pre-symbolication top-in-app frame and never refreshed once the worker fix
   * landed — this recomputes it from each issue's latest stored event frames
   * for every issue already in the org, so old issues don't have to wait for a
   * new event to show the right culprit. Safe to re-run; only writes when the
   * recomputed value differs.
   */
  @Post('admin/recompute-culprits')
  @UseGuards(JwtGuard)
  async recomputeCulprits(@Req() req: Request & { user?: AuthPrincipal }) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const projRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, req.user!.orgId));
    const projectIds = projRows.map((p) => p.id);
    if (projectIds.length === 0) return { checked: 0, updated: 0 };

    const issueRows = await db.select({ id: issues.id, culprit: issues.culprit }).from(issues).where(inArray(issues.projectId, projectIds));
    let updated = 0;
    for (const issue of issueRows) {
      const ev = await db
        .select({ exception: events.exception })
        .from(events)
        .where(eq(events.issueId, issue.id))
        .orderBy(desc(events.timestamp))
        .limit(1);
      const frames = (ev[0]?.exception as { frames?: NormalizedFrame[] } | undefined)?.frames;
      if (!frames || frames.length === 0) continue;
      const newCulprit = computeCulprit(frames) ?? null;
      if (newCulprit && newCulprit !== issue.culprit) {
        await db.update(issues).set({ culprit: newCulprit }).where(eq(issues.id, issue.id));
        updated++;
      }
    }
    return { checked: issueRows.length, updated };
  }

  /**
   * One-time backfill: replays whose `issueId` was never resolved (the
   * matching error event landed AFTER the replay was processed — replay
   * segments are separate envelopes/jobs and can race ahead of the slower
   * symbolicated event job) are stuck at issueId=NULL forever with no
   * self-healing (the live path only backfills going forward, once the fix
   * shipped). Re-runs the same trace-id match for every still-orphaned replay
   * in the org. Safe to re-run; only writes rows that resolve to an issue.
   */
  @Post('admin/recompute-replay-links')
  @UseGuards(JwtGuard)
  async recomputeReplayLinks(@Req() req: Request & { user?: AuthPrincipal }) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const projRows = await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, req.user!.orgId));
    const projectIds = projRows.map((p) => p.id);
    if (projectIds.length === 0) return { checked: 0, updated: 0 };

    const orphans = await db
      .select({
        id: replays.id,
        projectId: replays.projectId,
        traceId: replays.traceId,
        replayId: replays.replayId,
      })
      .from(replays)
      .where(and(inArray(replays.projectId, projectIds), isNull(replays.issueId)));
    let updated = 0;
    for (const r of orphans) {
      // replay_id match first (GD-197) — reliable regardless of trace sampling;
      // trace_id is a fallback for events recorded before replay_id was captured.
      let matchedIssueId: string | undefined;
      if (r.replayId) {
        const ev = await db
          .select({ issueId: events.issueId })
          .from(events)
          .where(and(eq(events.replayId, r.replayId), eq(events.projectId, r.projectId)))
          .orderBy(desc(events.timestamp))
          .limit(1);
        matchedIssueId = ev[0]?.issueId;
      }
      if (!matchedIssueId && r.traceId) {
        const ev = await db
          .select({ issueId: events.issueId })
          .from(events)
          .where(and(eq(events.traceId, r.traceId), eq(events.projectId, r.projectId)))
          .orderBy(desc(events.timestamp))
          .limit(1);
        matchedIssueId = ev[0]?.issueId;
      }
      if (matchedIssueId) {
        await db.update(replays).set({ issueId: matchedIssueId }).where(eq(replays.id, r.id));
        updated++;
      }
    }
    return { checked: orphans.length, updated };
  }

  /* --------------- Deploy-pipeline artifact registration (FR-BLD-2) -------- */
  @Post('api/:projectId/releases/:release/artifacts')
  async registerArtifacts(
    @Param('projectId') projectId: string,
    @Param('release') release: string,
    @Req() req: Request,
    @Body()
    body: { commitSha?: string; artifacts?: { debugId: string; r2Key: string; checksum?: string; size?: number }[] },
  ) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('missing org token');
    const presented = auth.slice(7);

    // Verify against org tokens for this project's org (secret, hashed at rest).
    const proj = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (proj.length === 0) throw new UnauthorizedException('unknown project');
    const tokens = await db.select({ hash: orgTokens.tokenHash }).from(orgTokens).where(eq(orgTokens.orgId, proj[0].orgId));
    let ok = false;
    for (const t of tokens) {
      if (await bcrypt.compare(presented, t.hash)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new UnauthorizedException('invalid org token');

    // Upsert the release (bind commit), then index the artifacts (FR-MAP-2).
    const rel = await db
      .insert(releases)
      .values({ projectId, version: release, commitSha: body.commitSha })
      .onConflictDoUpdate({
        target: [releases.projectId, releases.version],
        set: { commitSha: body.commitSha ?? null },
      })
      .returning({ id: releases.id });
    const releaseId = rel[0].id;

    for (const a of body.artifacts ?? []) {
      await db.insert(sourceMapArtifacts).values({
        releaseId,
        projectId,
        debugId: a.debugId,
        r2Key: a.r2Key,
        checksum: a.checksum,
        size: a.size,
      });
    }
    return { ok: true, registered: (body.artifacts ?? []).length };
  }

  /* --------------- Source-map upload via API (FR-BLD-2) -------------------- */
  /**
   * Accepts base64-encoded .map files, uploads them to R2, and registers the
   * artifact index. Used by the Vercel build script so R2 creds stay server-side.
   * Body: { files: [{ name, content (base64) }], commitSha? }
   */
  @Post('api/:projectId/releases/:release/upload')
  async uploadSourceMaps(
    @Param('projectId') projectId: string,
    @Param('release') release: string,
    @Req() req: Request,
    @Body() body: { files?: { name: string; content: string }[]; commitSha?: string },
  ) {
    // Auth — same org-token check as registerArtifacts.
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('missing org token');
    const presented = auth.slice(7);
    const proj = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (proj.length === 0) throw new UnauthorizedException('unknown project');
    const tokens = await db.select({ hash: orgTokens.tokenHash }).from(orgTokens).where(eq(orgTokens.orgId, proj[0].orgId));
    let tokenOk = false;
    for (const t of tokens) {
      if (await bcrypt.compare(presented, t.hash)) { tokenOk = true; break; }
    }
    if (!tokenOk) throw new UnauthorizedException('invalid org token');

    if (!body.files?.length) throw new BadRequestException('files array required');

    // Resolve R2 config from env (ops override) or DB integrations row.
    const r2Cfg = await this.resolveR2Config();
    if (!r2Cfg) throw new BadRequestException('R2 not configured — connect it in Settings → Integrations');

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto',
      endpoint: r2Cfg.endpoint,
      credentials: { accessKeyId: r2Cfg.accessKeyId, secretAccessKey: r2Cfg.secretAccessKey },
    });

    // Upsert the release.
    const rel = await db
      .insert(releases)
      .values({ projectId, version: release, commitSha: body.commitSha })
      .onConflictDoUpdate({ target: [releases.projectId, releases.version], set: { commitSha: body.commitSha ?? null } })
      .returning({ id: releases.id });
    const releaseId = rel[0].id;

    let uploaded = 0;
    for (const f of body.files) {
      const buf = Buffer.from(f.content, 'base64');

      // Read the debug_id that the Sentry SDK injected into the source map.
      // The SDK puts a UUID-format "debugId" at the top level of the .map JSON;
      // error events carry the same ID in debug_meta.images[].debug_id, so the
      // worker's symbolicate() can look it up. Fall back to a content hash when
      // the field is missing (non-Sentry builds, manual uploads, etc.).
      let debugId: string;
      let source: string;
      try {
        const map = JSON.parse(buf.toString('utf8'));
        if (map.debugId) { debugId = map.debugId; source = 'debugId'; }
        else if (map['debug_id']) { debugId = map['debug_id']; source = 'debug_id'; }
        else { debugId = createHash('sha256').update(buf).digest('hex').slice(0, 32); source = 'sha256-fallback'; }
      } catch {
        debugId = createHash('sha256').update(buf).digest('hex').slice(0, 32);
        source = 'parse-error-fallback';
      }
      if (uploaded < 3) console.log(`[upload] ${f.name} → debugId=${debugId} (source=${source})`);

      const r2Key = `sourcemaps/${projectId}/${debugId}.map`;
      await s3.send(new PutObjectCommand({ Bucket: r2Cfg.bucket, Key: r2Key, Body: buf, ContentType: 'application/json' }));
      await db.insert(sourceMapArtifacts).values({
        releaseId, projectId, debugId, r2Key,
        checksum: createHash('sha1').update(buf).digest('hex'),
        size: buf.length,
      });
      uploaded++;
    }

    return { ok: true, uploaded, release };
  }

  private async resolveR2Config(): Promise<{ endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string } | null> {
    // Env vars first (ops override).
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET } = process.env;
    if (R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT && R2_BUCKET) {
      return { endpoint: R2_ENDPOINT, bucket: R2_BUCKET, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY };
    }
    // Fall back to encrypted DB integrations row.
    try {
      const row = await getActiveIntegration('r2');
      if (row?.secretEnc) {
        const sec = JSON.parse(decrypt(row.secretEnc)) as { accessKeyId?: string; secretAccessKey?: string };
        const cfg = row.config as { endpoint?: string; bucket?: string };
        if (cfg.endpoint && cfg.bucket && sec.accessKeyId && sec.secretAccessKey) {
          return { endpoint: cfg.endpoint, bucket: cfg.bucket, accessKeyId: sec.accessKeyId, secretAccessKey: sec.secretAccessKey };
        }
      }
    } catch { /* ignore */ }
    return null;
  }
}
