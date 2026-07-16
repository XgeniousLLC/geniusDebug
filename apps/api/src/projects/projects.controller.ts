import { Controller, Get, Param, UseGuards, Req } from '@nestjs/common';
import type { Request } from 'express';
import { db, projects, dsnKeys, environments } from '@geniusdebug/db';
import { eq, and } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';

@Controller('projects')
@UseGuards(JwtGuard)
export class ProjectsController {
  @Get()
  async list(@Req() req: Request & { user?: AuthPrincipal }) {
    const orgId = req.user!.orgId;
    return db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        platform: projects.platform,
        ingestEnabled: projects.ingestEnabled,
      })
      .from(projects)
      .where(eq(projects.orgId, orgId));
  }

  @Get(':id/keys')
  async keys(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    const orgId = req.user!.orgId;
    const proj = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, orgId)))
      .limit(1);
    if (proj.length === 0) return [];
    return db
      .select({ publicKey: dsnKeys.publicKey, isActive: dsnKeys.isActive, rateLimit: dsnKeys.rateLimit })
      .from(dsnKeys)
      .where(eq(dsnKeys.projectId, id));
  }

  @Get(':id/environments')
  async envs(@Param('id') id: string) {
    return db.select({ name: environments.name }).from(environments).where(eq(environments.projectId, id));
  }
}
