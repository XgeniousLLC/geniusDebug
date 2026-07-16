import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards, ForbiddenException, BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { db, githubApps, repositories, projects } from '@geniusdebug/db';
import { and, eq } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { GithubService } from './github.service';
import { encrypt } from '../crypto';

const API_URL = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? 4002}`;
const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5199';

/**
 * GitHub App **manifest flow** (Coolify-style, FR-GH-1). Supports creating the App
 * under a personal or org GitHub account, then installing it on selected repos.
 */
@Controller('github')
export class GithubController {
  constructor(private readonly gh: GithubService) {}

  /** Build the manifest + the GitHub URL to POST it to (personal or org). */
  @Post('app/manifest')
  @UseGuards(JwtGuard)
  async manifest(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { account?: 'personal' | 'org'; org?: string },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const state = Buffer.from(JSON.stringify({ orgId: req.user!.orgId })).toString('base64url');

    // Personal → /settings/apps/new; org → /organizations/<org>/settings/apps/new.
    const postUrl =
      body.account === 'org' && body.org
        ? `https://github.com/organizations/${body.org}/settings/apps/new`
        : 'https://github.com/settings/apps/new';

    const manifest = {
      name: `geniusDebug-${req.user!.orgId.slice(0, 8)}`,
      url: WEB_URL,
      redirect_url: `${API_URL}/github/app/callback`,
      callback_urls: [`${API_URL}/github/installation/callback`],
      setup_url: `${API_URL}/github/installation/callback`,
      hook_attributes: { url: `${API_URL}/github/webhook`, active: false },
      public: false,
      default_permissions: { contents: 'read', metadata: 'read' }, // least-privilege (FR-GH-8)
      default_events: [],
    };
    return { postUrl, manifest, state };
  }

  /** GitHub redirects here after the user creates the App; convert code → creds. */
  @Get('app/callback')
  async appCallback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    if (!code || !state) return res.status(400).send('missing code/state');
    let orgId: string;
    try {
      orgId = JSON.parse(Buffer.from(state, 'base64url').toString()).orgId;
    } catch {
      return res.status(400).send('bad state');
    }
    const app = await this.gh.convertManifest(code);
    // Store encrypted at rest (NFR-SEC-5); one app per org.
    await db.delete(githubApps).where(eq(githubApps.orgId, orgId));
    await db.insert(githubApps).values({
      orgId,
      name: `geniusDebug-${orgId.slice(0, 8)}`,
      slug: app.slug,
      appId: String(app.id),
      clientId: app.client_id,
      clientSecretEnc: encrypt(app.client_secret),
      privateKeyEnc: encrypt(app.pem),
      webhookSecretEnc: app.webhook_secret ? encrypt(app.webhook_secret) : null,
      ownerLogin: app.owner?.login,
    });
    // Send the admin back to Settings, then straight into the install step.
    return res.redirect(`${WEB_URL}/settings?github=created&slug=${app.slug}`);
  }

  /** Current App for the caller's org + the install URL (FR-GH-1). */
  @Get('app')
  @UseGuards(JwtGuard)
  async currentApp(@Req() req: Request & { user?: AuthPrincipal }) {
    const rows = await db
      .select({ slug: githubApps.slug, ownerLogin: githubApps.ownerLogin })
      .from(githubApps)
      .where(eq(githubApps.orgId, req.user!.orgId))
      .limit(1);
    if (rows.length === 0) return { installed: false };
    return {
      installed: true,
      slug: rows[0].slug,
      ownerLogin: rows[0].ownerLogin,
      installUrl: `https://github.com/apps/${rows[0].slug}/installations/new`,
    };
  }

  /** After install, GitHub sends installation_id here → back to the repo picker. */
  @Get('installation/callback')
  async installCallback(@Query('installation_id') installationId: string, @Res() res: Response) {
    return res.redirect(`${WEB_URL}/settings?installation_id=${installationId ?? ''}`);
  }

  /** List repos the installation can access, so the admin can pick one. */
  @Get('installations/:installationId/repos')
  @UseGuards(JwtGuard)
  async repos(@Req() req: Request & { user?: AuthPrincipal }, @Param('installationId') installationId: string) {
    const creds = await this.gh.appForOrg(req.user!.orgId);
    if (!creds) throw new BadRequestException('no GitHub App for this org');
    const token = await this.gh.installationToken(creds, installationId);
    return this.gh.listInstallationRepos(token);
  }

  /** Link a chosen repo to a project (records installation_id) — FR-GH-1/2. */
  @Post('projects/:projectId/link')
  @UseGuards(JwtGuard)
  async link(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('projectId') projectId: string,
    @Body() body: { installationId?: string; owner?: string; name?: string; defaultBranch?: string },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const proj = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, req.user!.orgId)))
      .limit(1);
    if (proj.length === 0) throw new ForbiddenException('project not in org');
    if (!body.owner || !body.name) throw new BadRequestException('owner and name required');

    await db.delete(repositories).where(eq(repositories.projectId, projectId));
    await db.insert(repositories).values({
      projectId,
      provider: 'github',
      owner: body.owner,
      name: body.name,
      defaultBranch: body.defaultBranch || 'main',
      installationId: body.installationId,
      connectedByUserId: req.user!.userId,
    });
    return { ok: true };
  }
}
