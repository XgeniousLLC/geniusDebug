import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { issueListQuerySchema, issueActionSchema } from '@geniusdebug/shared';
import { IssuesService } from './issues.service';
import { JwtGuard, type AuthPrincipal } from '../auth/jwt.guard';

@Controller('issues')
@UseGuards(JwtGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}

  @Get()
  async list(@Req() req: Request & { user?: AuthPrincipal }, @Query() query: Record<string, unknown>) {
    const parsed = issueListQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.issues.list(req.user!, { ...parsed.data, projectId: query.projectId as string | undefined });
  }

  @Get(':shortId')
  async detail(@Req() req: Request & { user?: AuthPrincipal }, @Param('shortId') shortId: string) {
    return this.issues.detail(req.user!, shortId);
  }

  @Get(':shortId/replays')
  async replays(@Req() req: Request & { user?: AuthPrincipal }, @Param('shortId') shortId: string) {
    return this.issues.replaysForIssue(req.user!, shortId);
  }

  @Get(':shortId/similar')
  async similar(@Req() req: Request & { user?: AuthPrincipal }, @Param('shortId') shortId: string) {
    return this.issues.similarIssues(req.user!, shortId);
  }

  @Post(':shortId/actions')
  async act(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: unknown,
  ) {
    const parsed = issueActionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.issues.act(req.user!, shortId, req.user!.userId, parsed.data);
  }

  @Post(':shortId/merge')
  async merge(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: { targetShortId?: string },
  ) {
    if (!body.targetShortId) throw new BadRequestException('targetShortId required');
    return this.issues.merge(req.user!, shortId, body.targetShortId, req.user!.userId);
  }

  @Post(':shortId/share')
  async share(
    @Req() req: Request & { user?: AuthPrincipal },
    @Param('shortId') shortId: string,
    @Body() body: { enabled?: boolean },
  ) {
    return this.issues.setShare(req.user!, shortId, body.enabled !== false);
  }
}

/** Unauthenticated public issue view (GD-133) — NO JwtGuard. Read-only by token. */
@Controller('public/issues')
export class PublicIssueController {
  constructor(private readonly issues: IssuesService) {}

  @Get(':token')
  async view(@Param('token') token: string) {
    return this.issues.publicIssue(token);
  }
}
