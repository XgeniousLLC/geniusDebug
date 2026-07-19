import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';
import { SuggestService } from './suggest.service';

/**
 * AI fix suggester (FR-AIF, P1 diagnose). Read-only: produces an inert
 * suggestion — no repo mutation, no writes beyond our own table. Any role with
 * access to the issue's project may generate one (project-access scoped in the
 * service). Sole provider: DeepSeek.
 */
@Controller('issues/:shortId/suggest')
@UseGuards(JwtGuard)
export class SuggestController {
  constructor(private readonly svc: SuggestService) {}

  @Get()
  async latest(@Req() req: Request & { user?: AuthPrincipal }, @Param('shortId') shortId: string) {
    return this.svc.latestWithPr(req.user!, shortId);
  }

  /**
   * Open a DRAFT pull request from an approved suggestion (FR-AIF P4). Explicit
   * human action; admin-gated; no model in this path (deterministic patch apply).
   */
  @Post('pr')
  async openPr(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: { suggestionId?: string },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    if (!body?.suggestionId) throw new ForbiddenException('suggestionId required');
    return this.svc.openPr(req.user!, shortId, body.suggestionId);
  }

  /** Admin: enable/disable AI draft PRs for this issue's project repo (FR-AIF §3.3). */
  @Post('pr-enabled')
  async setPrEnabled(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: { enabled?: boolean },
  ) {
    if (req.user!.role !== 'admin') throw new ForbiddenException('admin only');
    return this.svc.setPrEnabled(req.user!, shortId, !!body?.enabled);
  }

  @Post()
  async generate(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: { refresh?: boolean },
  ) {
    return this.svc.generate(req.user!, shortId, !!body?.refresh);
  }
}
