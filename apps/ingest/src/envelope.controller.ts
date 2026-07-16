import { Controller, Post, Get, Param, Req, Res, Headers, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DsnService } from './dsn.service';
import { RateLimitService } from './ratelimit.service';
import { EnvelopeService } from './envelope.service';
import { ingestQueue, type IngestJob } from './queue';

/**
 * Sentry envelope endpoint (FR-ING-1..7). Authenticate → rate-limit →
 * shallow-validate → enqueue → 202. No heavy work inline (golden rule 2).
 * Accepts both direct DSN delivery and Taskip's tunnelRoute forwarder (FR-ING-7).
 */
@Controller()
export class EnvelopeController {
  constructor(
    private readonly dsn: DsnService,
    private readonly rl: RateLimitService,
    private readonly env: EnvelopeService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'ingest' };
  }

  private extractKey(query: Record<string, unknown>, auth?: string): string | undefined {
    if (typeof query.sentry_key === 'string') return query.sentry_key;
    if (auth) {
      const m = /sentry_key=([a-f0-9]+)/i.exec(auth);
      if (m) return m[1];
    }
    return undefined;
  }

  @Post('api/:projectId/envelope')
  @Post('api/:projectId/envelope/')
  async ingest(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-sentry-auth') sentryAuth: string | undefined,
    @Headers('content-encoding') contentEncoding: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const publicKey = this.extractKey(query, sentryAuth);
    if (!publicKey) return res.status(403).json({ error: 'missing sentry_key' });

    const key = await this.dsn.resolve(publicKey, projectId);
    if (!key) return res.status(403).json({ error: 'invalid or disabled key' });

    // Remote kill switch (FR-SDK-8): drop cheaply if ingest disabled for project.
    if (!key.ingestEnabled) return res.status(202).json({ status: 'disabled' });

    const gate = await this.rl.check(projectId, key.rateLimit);
    if (gate.limited) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: 'rate limited' });
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
    const result = this.env.shallowValidate(raw, contentEncoding);
    if (!result.ok) return res.status(result.status ?? 400).json({ error: result.reason });

    const job: IngestJob = {
      projectId,
      envelopeB64: result.bytes.toString('base64'),
      eventId: result.eventId,
      receivedAt: new Date().toISOString(),
    };
    // Idempotency key on event_id (FR-WRK-2 dedupe starts here).
    await ingestQueue.add('envelope', job, {
      jobId: result.eventId ? `${projectId}_${result.eventId}` : undefined,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
    });

    return res.status(202).json({ status: 'accepted', id: result.eventId });
  }
}
