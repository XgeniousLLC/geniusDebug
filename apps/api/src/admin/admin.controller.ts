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
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, repositories, releases, orgTokens, sourceMapArtifacts, projects, users, memberships, dsnKeys } from '@geniusdebug/db';
import { and, eq, ne } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';

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
    return db
      .select({ id: users.id, name: users.name, email: users.email, role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, req.user!.orgId));
  }

  @Post('members')
  @UseGuards(JwtGuard)
  async invite(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name?: string; email?: string; role?: 'admin' | 'member' },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    if (!body.email || !body.name) throw new BadRequestException('name and email required');
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) throw new BadRequestException('email already a member');
    // v1 invite: create the user with a random temp password (they reset on first login).
    const tempHash = await bcrypt.hash(`temp_${randomBytes(12).toString('hex')}`, 10);
    const u = await db
      .insert(users)
      .values({ orgId: req.user!.orgId, email: body.email, name: body.name, passwordHash: tempHash })
      .returning({ id: users.id });
    await db.insert(memberships).values({ orgId: req.user!.orgId, userId: u[0].id, role: body.role ?? 'member' });
    return { ok: true, id: u[0].id };
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
}
