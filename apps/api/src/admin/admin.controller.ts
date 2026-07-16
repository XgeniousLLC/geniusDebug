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
import { db, repositories, releases, orgTokens, sourceMapArtifacts, projects } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';
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
