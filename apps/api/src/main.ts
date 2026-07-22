import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { HtmlExceptionFilter } from './http-pages';

async function bootstrap() {
  // Configure Express with a 100 MB JSON body limit *before* NestJS registers
  // its own body parser — otherwise the default 100 KB limit wins.
  const server = express();
  server.use(express.json({ limit: '100mb' }));

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  app.enableCors({ origin: true });
  app.setGlobalPrefix('', { exclude: [] });
  app.useGlobalFilters(new HtmlExceptionFilter());
  const port = Number(process.env.API_PORT ?? 4002);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${port}`);
}

bootstrap();
