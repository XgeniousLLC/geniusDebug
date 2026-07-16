import { Body, Controller, Delete, Param, Patch, Post, Req, UseGuards, BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { db, alertRules, projects } from '@geniusdebug/db';
import { and, eq, inArray } from 'drizzle-orm';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';

interface RuleBody {
  projectId?: string;
  name?: string;
  conditions?: { new?: boolean; regression?: boolean; frequency?: { count: number; windowMin: number } };
  environmentFilter?: string | null;
  levelFilter?: 'fatal' | 'error' | 'warning' | 'info' | 'debug' | null;
  recipients?: string[];
  throttleWindow?: number;
  isActive?: boolean;
}

/** Alert rule editor (FR-ALR-5) + snooze (FR-ALR-7). Admin-gated. */
@Controller('alerts')
@UseGuards(JwtGuard)
export class AlertsController {
  private async orgProjectIds(orgId: string): Promise<string[]> {
    return (await db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId))).map((r) => r.id);
  }

  @Post()
  async create(@Req() req: Request & { user?: AuthPrincipal }, @Body() body: RuleBody) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    const pids = await this.orgProjectIds(req.user!.orgId);
    const projectId = body.projectId ?? pids[0];
    if (!projectId || !pids.includes(projectId)) throw new BadRequestException('invalid project');
    if (!body.name) throw new BadRequestException('name required');
    const rows = await db
      .insert(alertRules)
      .values({
        projectId,
        name: body.name,
        conditions: body.conditions ?? { new: true },
        environmentFilter: body.environmentFilter ?? null,
        levelFilter: body.levelFilter ?? null,
        recipients: body.recipients ?? [],
        throttleWindow: body.throttleWindow ?? 3600,
        isActive: body.isActive ?? true,
      })
      .returning({ id: alertRules.id });
    return { ok: true, id: rows[0].id };
  }

  @Patch(':id')
  async update(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string, @Body() body: RuleBody) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertRuleInOrg(req.user!.orgId, id);
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'conditions', 'environmentFilter', 'levelFilter', 'recipients', 'throttleWindow', 'isActive'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    await db.update(alertRules).set(patch).where(eq(alertRules.id, id));
    return { ok: true };
  }

  @Post(':id/snooze')
  async snooze(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string, @Body() body: { minutes?: number }) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertRuleInOrg(req.user!.orgId, id);
    const until = body.minutes ? new Date(Date.now() + body.minutes * 60 * 1000) : null;
    await db.update(alertRules).set({ mutedUntil: until }).where(eq(alertRules.id, id));
    return { ok: true, mutedUntil: until };
  }

  @Delete(':id')
  async remove(@Req() req: Request & { user?: AuthPrincipal }, @Param('id') id: string) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    await this.assertRuleInOrg(req.user!.orgId, id);
    await db.delete(alertRules).where(eq(alertRules.id, id));
    return { ok: true };
  }

  private async assertRuleInOrg(orgId: string, ruleId: string) {
    const pids = await this.orgProjectIds(orgId);
    const rows = await db
      .select({ id: alertRules.id })
      .from(alertRules)
      .where(and(eq(alertRules.id, ruleId), inArray(alertRules.projectId, pids.length ? pids : [''])))
      .limit(1);
    if (rows.length === 0) throw new ForbiddenException('rule not in org');
  }
}
