import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import {
  db,
  projects,
  dsnKeys,
  environments,
  alertRules,
  events,
  spans,
  traces,
} from '@geniusdebug/db';
import { eq, and, inArray } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { sendEmail } from '../mailer';
import { accessibleProjectIds, assertProjectAccess } from '../access';

const DEFAULT_ENVS = ['vercel-production', 'preview', 'development'];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

@Controller('projects')
@UseGuards(JwtGuard)
export class ProjectsController {
  @Get()
  async list(@Req() req: Request & { user?: AuthPrincipal }) {
    // Members only see projects granted to them; admins see all (NFR-SEC-6).
    const ids = await accessibleProjectIds(req.user!);
    if (ids.length === 0) return [];
    return db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        platform: projects.platform,
        ingestEnabled: projects.ingestEnabled,
        setupCompletedAt: projects.setupCompletedAt,
      })
      .from(projects)
      .where(inArray(projects.id, ids));
  }

  /** Assert the caller may access this project (org + member grant); return id + name. */
  private async assertInOrg(user: AuthPrincipal, id: string): Promise<{ id: string; name: string }> {
    await assertProjectAccess(user, id);
    const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, id)).limit(1);
    if (rows.length === 0) throw new ForbiddenException('project not in org');
    return rows[0];
  }

  /**
   * Create a project (FR-ADM). Admin-only, org-scoped. Provisions the same
   * defaults as first-time register: a write-only DSN key, standard envs, and a
   * default alert rule — so a new project is usable the moment it exists.
   */
  @Post()
  async create(
    @Req() req: Request & { user?: AuthPrincipal },
    @Body() body: { name?: string; slug?: string; platform?: string },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const orgId = req.user!.orgId;

    const name = (body.name ?? '').trim();
    if (!name) throw new BadRequestException('name required');
    const slug = slugify(body.slug || name);
    if (!slug) throw new BadRequestException('slug required');
    const platform = (body.platform ?? 'javascript-nextjs').trim() || 'javascript-nextjs';

    // Unique (org, slug) — DB enforces via projects_org_slug_uq; pre-check for a clean 409.
    const clash = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
      .limit(1);
    if (clash.length > 0) throw new ConflictException(`slug "${slug}" already in use`);

    return db.transaction(async (tx) => {
      const proj = await tx
        .insert(projects)
        .values({ orgId, name, slug, platform })
        .returning({ id: projects.id, name: projects.name, slug: projects.slug, platform: projects.platform, ingestEnabled: projects.ingestEnabled });
      const projectId = proj[0].id;

      const publicKey = randomBytes(16).toString('hex');
      await tx.insert(dsnKeys).values({ projectId, publicKey, rateLimit: 3000 });

      for (const n of DEFAULT_ENVS) {
        await tx.insert(environments).values({ projectId, name: n });
      }

      await tx.insert(alertRules).values({
        projectId,
        name: 'Default — new & regressed issues',
        conditions: { new: true, regression: true },
        recipients: [req.user!.email],
        channel: 'email',
        throttleWindow: 3600,
      });

      return proj[0];
    });
  }

  /**
   * Delete a project (FR-ADM). Admin-only, org-scoped. FK cascade clears
   * dsn_keys, environments, repositories, releases, source maps, issues,
   * traces, replays, alert rules and notifications; `events` and `spans` have no
   * FK (events is partitioned, spans key off trace_id) so they are cleared
   * explicitly first. An org must keep at least one project.
   *
   * Note: R2 blobs (replay recordings, source maps) are not reaped here — the
   * API has no R2 client. They age out via the retention/lifecycle policy.
   */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const orgId = req.user!.orgId;

    const owned = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
      .limit(1);
    if (owned.length === 0) throw new ForbiddenException('project not in org');

    const count = await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId));
    if (count.length <= 1) throw new BadRequestException('cannot delete the last project in the org');

    await db.transaction(async (tx) => {
      // spans have no FK → delete by the project's trace ids before traces cascade.
      const tr = await tx.select({ traceId: traces.traceId }).from(traces).where(eq(traces.projectId, id));
      if (tr.length > 0) {
        await tx.delete(spans).where(inArray(spans.traceId, tr.map((t) => t.traceId)));
      }
      // events are partitioned (no FK) → delete by project id.
      await tx.delete(events).where(eq(events.projectId, id));
      // everything else cascades from the project row.
      await tx.delete(projects).where(eq(projects.id, id));
    });
  }

  @Get(':id/keys')
  async keys(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    await assertProjectAccess(req.user!, id);
    return db
      .select({ publicKey: dsnKeys.publicKey, isActive: dsnKeys.isActive, rateLimit: dsnKeys.rateLimit })
      .from(dsnKeys)
      .where(eq(dsnKeys.projectId, id));
  }

  @Get(':id/environments')
  async envs(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    await assertProjectAccess(req.user!, id);
    return db.select({ name: environments.name }).from(environments).where(eq(environments.projectId, id));
  }

  /**
   * Mark the SDK integration setup complete / incomplete (onboarding). Any org
   * member — wiring the SDK is a developer task, not admin-only.
   */
  @Post(':id/setup')
  async setSetup(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { completed?: boolean },
  ) {
    await this.assertInOrg(req.user!, id);
    const completed = body.completed !== false;
    await db.update(projects).set({ setupCompletedAt: completed ? new Date() : null }).where(eq(projects.id, id));
    return { ok: true, completed };
  }

  /**
   * Email SDK setup instructions to a developer. Any org member. Uses SES
   * (env → DB integration); returns { sent:false, reason } gracefully when SES
   * isn't configured so the UI can offer a copy/mailto fallback.
   */
  @Post(':id/setup/email')
  async emailSetup(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('id') id: string,
    @Body() body: { email?: string; note?: string; dsn?: string },
  ) {
    const proj = await this.assertInOrg(req.user!, id);
    const email = body.email?.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestException('valid email required');

    // Resolve a DSN: prefer the client-provided one (it knows the public origin),
    // else build from the active key + a configured ingest origin.
    let dsn = body.dsn?.trim();
    if (!dsn) {
      const key = await db
        .select({ publicKey: dsnKeys.publicKey })
        .from(dsnKeys)
        .where(and(eq(dsnKeys.projectId, id), eq(dsnKeys.isActive, true)))
        .limit(1);
      const origin = (process.env.PUBLIC_INGEST_ORIGIN ?? 'http://localhost:4001').replace(/^https?:\/\//, '');
      dsn = key[0] ? `https://${key[0].publicKey}@${origin}/${id}` : `https://<key>@${origin}/${id}`;
    }

    const html = buildSetupEmail(proj.name, dsn, req.user!.email, body.note);
    const res = await sendEmail([email], `Set up error monitoring for ${proj.name}`, html, req.user!.orgId);
    return { ...res, to: email };
  }
}

/** SDK setup instructions email (developer-facing). */
function buildSetupEmail(projectName: string, dsn: string, from: string, note?: string): string {
  const init = `Sentry.init({
  dsn: "${dsn}",
  tunnelRoute: "/monitoring",
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
});`;
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 8px">Set up error monitoring — ${escapeHtml(projectName)}</h2>
    <p style="color:#555;margin:0 0 16px">${escapeHtml(from)} asked you to wire this app to geniusDebug (self-hosted, Sentry-SDK compatible).</p>
    ${note ? `<blockquote style="border-left:3px solid #ddd;margin:0 0 16px;padding:4px 12px;color:#444">${escapeHtml(note)}</blockquote>` : ''}
    <ol style="color:#333;line-height:1.6;padding-left:20px">
      <li>Install: <code>npm i @sentry/nextjs</code></li>
      <li>Add the config below to <code>sentry.client.config.ts</code> (and server/edge).</li>
      <li>Wrap <code>next.config.js</code> with <code>withSentryConfig</code>; set the tunnel route.</li>
      <li>Deploy — errors will appear in the geniusDebug dashboard within seconds.</li>
    </ol>
    <pre style="background:#0d1117;color:#e6edf3;padding:12px;border-radius:8px;overflow:auto;font-size:13px"><code>${escapeHtml(init)}</code></pre>
    <p style="color:#888;font-size:12px;margin-top:16px">DSN is public and write-only — safe to commit. It cannot read data.</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
