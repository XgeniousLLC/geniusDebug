import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HtmlExceptionFilter } from './http-pages';
import { r2Configured } from './r2';

const MAX_ENVELOPE_BYTES = Number(process.env.MAX_ENVELOPE_BYTES ?? 209_715_200);

async function bootstrap() {
  const server = express();
  // Raw body for envelopes — keep bytes opaque so the hot path never JSON-parses
  // payloads, and so a `Content-Encoding: gzip` envelope reaches EnvelopeService
  // still compressed for its own gunzip step (FR-ING-3). NOT express.raw()/
  // body-parser: body-parser auto-inflates gzip/deflate bodies by default (its
  // `inflate` option defaults to true), which silently double-decompresses any
  // gzip'd client (e.g. sentry-php's curl transport) before we ever see the
  // bytes — EnvelopeService's own gunzipSync then fails on already-plain JSON
  // ("incorrect header check"). Collect the socket bytes ourselves so nothing
  // upstream ever interprets Content-Encoding.
  server.use((req, res, next) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_ENVELOPE_BYTES) {
        aborted = true;
        res.status(413).json({ error: 'envelope too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      (req as express.Request & { body?: Buffer }).body = Buffer.concat(chunks);
      next();
    });
    req.on('error', (err) => {
      if (!aborted) next(err);
    });
  });

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    bodyParser: false,
  });
  app.enableCors({ origin: true });
  app.useGlobalFilters(new HtmlExceptionFilter());

  const port = Number(process.env.INGEST_PORT ?? 4001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[ingest] listening on :${port}`);

  // Warn if R2 isn't reachable — replays will have no DOM playback without it.
  const r2 = await r2Configured().catch(() => false);
  if (!r2) {
    // eslint-disable-next-line no-console
    console.warn('[ingest] ⚠ R2 not configured — replay recording blobs will NOT be stored. Set R2 env vars or connect R2 in Integrations. Also ensure APP_ENCRYPTION_KEY is the same across all services.');
  }
}

bootstrap();
