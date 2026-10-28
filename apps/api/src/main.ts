import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './config/env';
import { requestContextMiddleware } from './common/request-context';
import { JsonLogger } from './logging/json-logger';
import { databaseHost, databaseUrl } from './db/database-url';

// Redeploy trigger 2026-10-28: no functional change.
async function bootstrap() {
  const cfg = env(); // fail fast on invalid / insecure configuration
  const json_ = (cfg.LOG_FORMAT ?? (cfg.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'json';
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: json_ ? new JsonLogger() : cfg.NODE_ENV === 'production' ? ['log', 'warn', 'error'] : ['log', 'warn', 'error', 'debug'],
    bodyParser: false,
  });
  if (cfg.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestContextMiddleware); // request id + trusted client IP for every request, before anything else
  app.use(json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(
    helmet({
      contentSecurityPolicy: cfg.NODE_ENV === 'production' ? undefined : false,
      crossOriginEmbedderPolicy: false,
      hsts: cfg.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );
  const origins = cfg.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-step-up', 'x-client', 'x-request-id', 'apollo-require-preflight'],
    exposedHeaders: ['x-request-id'],
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  await app.listen(cfg.PORT, '0.0.0.0');
  new Logger('Bootstrap').log(`${cfg.APP_NAME} API listening on :${cfg.PORT}/graphql  (trading mode: SIMULATED)`);
  const url = databaseUrl({ DATABASE_URL: cfg.DATABASE_URL, DATABASE_URL_UNPOOLED: cfg.DATABASE_URL_UNPOOLED });
  new Logger('Bootstrap').log(`database ${databaseHost(url)} (${url === cfg.DATABASE_URL_UNPOOLED ? 'direct, DATABASE_URL_UNPOOLED' : 'DATABASE_URL'})`);
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
