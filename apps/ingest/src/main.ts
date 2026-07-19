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
  // payloads. Size cap here backstops FR-ING-4 (413 handled in the service too).
  server.use(
    express.raw({
      type: () => true,
      limit: MAX_ENVELOPE_BYTES,
    }),
  );

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
