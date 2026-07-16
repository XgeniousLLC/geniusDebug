import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';

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

  const port = Number(process.env.INGEST_PORT ?? 4001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[ingest] listening on :${port}`);
}

bootstrap();
