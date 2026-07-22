import 'reflect-metadata';
import 'dotenv/config';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HtmlExceptionFilter } from './http-pages';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  // Increase JSON body limit for source-map uploads (550+ .map files base64-encoded).
  app.use(express.json({ limit: '50mb' }));
  app.setGlobalPrefix('', { exclude: [] });
  app.useGlobalFilters(new HtmlExceptionFilter());
  const port = Number(process.env.API_PORT ?? 4002);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[api] listening on :${port}`);
}

bootstrap();
