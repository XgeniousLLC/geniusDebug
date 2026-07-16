import { Controller, Post, Get, Param, Req, Res, Headers, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DsnService } from './dsn.service';
import { RateLimitService } from './ratelimit.service';
import { EnvelopeService } from './envelope.service';
import { ingestQueue, connection, type IngestJob } from './queue';
import { splitOversizedBlobs } from './split-blobs';

/** Aggregate dropped-event counters (FR-ING-6) — cheap Redis INCR, daily bucket. */
async function countDrop(projectId: string, reason: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `drops:${projectId}:${reason}:${day}`;
  const n = await connection.incr(key);
  if (n === 1) await connection.expire(key, 60 * 60 * 24 * 8);
}

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

  /**
   * Public remote-config for the SDK kill switch (FR-SDK-8 / NFR-PERF-4). The
   * write-only DSN key may read its own non-sensitive config. Taskip polls this
   * (cached) so geniusDebug can be disabled/throttled without a redeploy.
   */
  @Get('api/:projectId/config')
  async config(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, unknown>,
    @Headers('x-sentry-auth') sentryAuth: string | undefined,
    @Res() res: Response,
  ) {
    const publicKey = this.extractKey(query, sentryAuth);
    if (!publicKey) return res.status(403).json({ error: 'missing sentry_key' });
    const key = await this.dsn.resolve(publicKey, projectId);
    if (!key) return res.status(403).json({ error: 'invalid key' });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      enabled: key.ingestEnabled,
      tracesSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
      replaysSessionSampleRate: 0,
    });
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
    if (!key.ingestEnabled) {
      await countDrop(projectId, 'disabled');
      return res.status(202).json({ status: 'disabled' });
    }

    const gate = await this.rl.check(projectId, key.rateLimit);
    if (gate.limited) {
      await countDrop(projectId, 'rate_limited');
      res.setHeader('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: 'rate limited' });
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
    const result = this.env.shallowValidate(raw, contentEncoding);
    if (!result.ok) {
      await countDrop(projectId, result.status === 413 ? 'too_large' : 'invalid');
      return res.status(result.status ?? 400).json({ error: result.reason });
    }

    // Stream oversized replay/attachment blobs to R2; enqueue only a pointer so the
    // big blob never sits in the queue (FR-ING-4/FR-RPL-2). No-op without R2.
    const { inline, blobs } = await splitOversizedBlobs(result.bytes, projectId, result.eventId);

    const job: IngestJob = {
      projectId,
      envelopeB64: inline.toString('base64'),
      eventId: result.eventId,
      receivedAt: new Date().toISOString(),
      blobs: blobs.length ? blobs : undefined,
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
