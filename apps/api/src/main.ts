import 'reflect-metadata';
import { jsonBodyLimits } from './common/body-limits';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './config/env';
import { requestContextMiddleware } from './common/request-context';
import { JsonLogger } from './logging/json-logger';
import { databaseHost, databaseUrl } from './db/database-url';

// Redeploy trigger 2026-10-28: no functional change.

/**
 * Background jobs (order matching on every tick, risk checks, log flushing…) run outside any request. If the
 * database is briefly unreachable (a managed database waking up, a network blip) one of them fails, and an
 * unhandled rejection would make Node exit the whole API. Log it and keep serving; the job runs again on the
 * next tick. Only the error's kind and code are logged, never query parameters.
 */
process.on('unhandledRejection', (e: unknown) => {
  const err = e as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = err?.code ?? err?.cause?.code ?? 'no code';
  const what = (err?.cause?.message ?? err?.message ?? String(e)).split('\nparams:')[0].slice(0, 160);
  new Logger('Background').error(`Background task failed (${err?.name ?? 'Error'}, ${code}): ${what}`);
});
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
  app.use(jsonBodyLimits()); // 100 kB; 800 kB only for a fee payment with its screenshot
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
    allowedHeaders: ['x-upload', 'content-type', 'authorization', 'x-step-up', 'x-client', 'x-request-id', 'apollo-require-preflight'],
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
