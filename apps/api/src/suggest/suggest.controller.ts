import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
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
    return { suggestion: await this.svc.latest(req.user!, shortId) };
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
