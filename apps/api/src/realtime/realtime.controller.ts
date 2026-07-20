import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import IORedis from 'ioredis';
import { redisOptions } from '@geniusdebug/shared';
import { accessibleProjectIds } from '../access';
import type { AuthPrincipal } from '../auth/jwt.guard';

const REALTIME_CHANNEL = 'realtime';
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Realtime feed stream (GD-147) — Server-Sent Events. Workers publish a small
 * "feed changed" signal to Redis; this relays it to the browser so feeds refetch
 * only on change (replacing timer polling). Auth is by `?token=` (EventSource
 * cannot set Authorization headers); the JWT is verified before streaming.
 */
@Controller('events')
export class RealtimeController {
  constructor(private readonly jwt: JwtService) {}

  @Get('stream')
  async stream(
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
    @Query('projectId') projectId?: string,
  ) {
    let principal: AuthPrincipal;
    try {
      principal = this.jwt.verify<AuthPrincipal>(token ?? '');
    } catch {
      res.status(401).end();
      return;
    }
    const accessible = new Set(await accessibleProjectIds(principal));

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
    });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n'); // client reconnect backoff
    res.write(': connected\n\n');

    const sub = new IORedis(url, redisOptions(url));
    sub.subscribe(REALTIME_CHANNEL).catch(() => {});
    sub.on('message', (_ch, payload) => {
      try {
        const m = JSON.parse(payload) as { type: string; projectId: string };
        if (!accessible.has(m.projectId)) return; // scope to caller's projects
        if (projectId && m.projectId !== projectId) return; // scope to selected project
        res.write(`data: ${JSON.stringify({ type: m.type, projectId: m.projectId })}\n\n`);
      } catch {
        /* ignore malformed */
      }
    });

    const ping = setInterval(() => res.write(': ping\n\n'), 25_000); // keep the connection alive
    const cleanup = () => {
      clearInterval(ping);
      sub.disconnect();
      res.end();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }
}
