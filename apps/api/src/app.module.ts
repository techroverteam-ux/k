import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Controller, Get, Injectable, Module, type ExecutionContext } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { inputHygienePlugin, validationPipe } from './common/validation';
import { GqlExecutionContext, GraphQLModule } from '@nestjs/graphql';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { ConsentResolver } from './consent/consent.resolver';
import { StatementController } from './statements/statement.controller';
import { StatementResolver } from './statements/statement.resolver';
import { StatementService } from './statements/statement.service';
import type { Request, Response } from 'express';
import depthLimit from 'graphql-depth-limit';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { AuditService } from './audit/audit.service';
import { AuthGuardDeps } from './auth/auth.deps';
import { GqlAuthGuard } from './auth/auth.guard';
import { AuthResolver } from './auth/auth.resolver';
import { AuthService } from './auth/auth.service';
import { PasswordService } from './auth/password.service';
import { SmsProvider } from './auth/sms.provider';
import { complexityPlugin } from './common/complexity.plugin';
import { lim, type GqlContext } from './common/context';
import { createLoaders } from './common/loaders';
import { AdminResolver } from './config-mgmt/admin.resolver';
import { ConfigService } from './config-mgmt/config.service';
import { env } from './config/env';
import { DbModule, DbService } from './db/db';
import { LedgerService } from './ledger/ledger.service';
import { MarketDataService } from './market/market-data.service';
import { MarketResolver } from './market/market.resolver';
import { NotificationsService } from './notifications/notifications.service';
import { PaymentsResolver } from './payments/payments.resolver';
import { PaymentsService } from './payments/payments.service';
import { PolicyService } from './policy/policy.service';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SimulatedVenue } from './trading/execution-venue';
import { OrdersService } from './trading/orders.service';
import { OrderFieldsResolver, PositionFieldsResolver, TradingResolver } from './trading/trading.resolver';
import { UsersResolver } from './users/users.resolver';
import { UsersService } from './users/users.service';
import { clientIp, contextFromRequest, requestContext } from './common/request-context';
import { activityPlugin } from './logging/activity.plugin';
import { ActivityLogService } from './logging/activity-log.service';
import { LogMaintenanceService, quietOps } from './logging/log-maintenance.service';
import { LogsResolver } from './logging/logs.resolver';

/** Throttler that understands GraphQL and keys by client IP. */
@Injectable()
class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(ctx: ExecutionContext) {
    if (ctx.getType<string>() === 'graphql') {
      const c = GqlExecutionContext.create(ctx).getContext<GqlContext>();
      // subscriptions have no res; give the throttler a no-op header setter
      return { req: c.req ?? { ip: c.ip, headers: {} }, res: c.res ?? { header: () => undefined, setHeader: () => undefined } };
    }
    return super.getRequestResponse(ctx);
  }
  protected async getTracker(req: Record<string, any>) {
    // Same IP as the logs (also correct for requests relayed by the web app's proxy).
    return requestContext.get()?.ip ?? req.ip ?? 'unknown';
  }
}

@Controller()
class HealthController {
  constructor(private readonly dbs: DbService) {}
  @Get('health')
  async health() {
    await this.dbs.db.execute(sql`SELECT 1`);
    return { ok: true, mode: 'SIMULATED' };
  }
}

const SAFE_CODES = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'BAD_USER_INPUT', 'CONFLICT', 'RATE_LIMITED', 'STEP_UP_REQUIRED', 'MFA_REQUIRED', 'INSUFFICIENT_FUNDS', 'ORDER_REJECTED', 'NOT_ENABLED', 'GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_REQUEST']);

/** Never leak internals: unknown errors become a generic message. */
function formatError(f: GraphQLFormattedError, err: unknown): GraphQLFormattedError {
  const code = (f.extensions?.code as string) ?? 'INTERNAL_SERVER_ERROR';
  const original = (err as { originalError?: any })?.originalError;
  if (original?.name === 'ThrottlerException') return { message: 'Too many requests. Please slow down.', extensions: { code: 'RATE_LIMITED' } };
  if (SAFE_CODES.has(code)) {
    // A machine-readable reason (e.g. SESSION_REPLACED, CONSENT_REQUIRED) is safe to pass through; nothing else is.
    const reason = f.extensions?.reason;
    return { message: f.message, path: f.path, extensions: typeof reason === 'string' && /^[A-Z_]{3,40}$/.test(reason) ? { code, reason } : { code } };
  }
  if (original?.status === 403 || original?.response?.statusCode === 403) return { message: 'You do not have permission to do this.', extensions: { code: 'FORBIDDEN' } };
  if (env().NODE_ENV !== 'production') console.error('[graphql]', (err as Error)?.message ?? err, original?.stack ?? '');
  return { message: 'Something went wrong. Please try again.', path: f.path, extensions: { code: 'INTERNAL_SERVER_ERROR' } };
}

@Module({
  imports: [
    DbModule,
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: lim(300) }] }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [AuthGuardDeps],
      inject: [DbService, AuthService, ActivityLogService],
      useFactory: (dbs: DbService, auth: AuthService, activity: ActivityLogService): ApolloDriverConfig => {
        const prod = env().NODE_ENV === 'production';
        return {
          autoSchemaFile: true,
          sortSchema: true,
          path: '/graphql',
          introspection: !prod,
          playground: false,
          csrfPrevention: true,
          includeStacktraceInErrorResponses: false,
          validationRules: [depthLimit(8)],
          plugins: [inputHygienePlugin(), complexityPlugin(() => 1500), activityPlugin(() => activity, () => quietOps.set)],
          formatError,
          subscriptions: {
            'graphql-ws': {
              path: '/graphql',
              onConnect: async (ctx: any) => {
                const rc = contextFromRequest(ctx.extra.request);
                ctx.extra.rc = rc;
                const raw = ctx.connectionParams?.authorization ?? ctx.connectionParams?.Authorization;
                const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : undefined;
                let ok = false;
                try {
                  if (token) {
                    ctx.extra.actor = await auth.verifyAccess(token);
                    ok = true;
                  }
                } catch {
                  ok = false;
                }
                const a = ctx.extra.actor;
                activity.record({ rc, userId: a?.userId, role: a?.role, sessionId: a?.sessionId, opType: 'ws.connect', opName: 'liveFeed', outcome: ok ? 'OK' : 'ERROR', errorCode: ok ? null : 'UNAUTHENTICATED', durationMs: Date.now() - rc.startedAt });
                return ok;
              },
              onSubscribe: (ctx: any, msg: any) => {
                const rc = ctx.extra.rc;
                const a = ctx.extra.actor;
                if (rc && a) {
                  const field = /\{\s*(\w+)/.exec(String(msg?.payload?.query ?? ''))?.[1] ?? null;
                  activity.record({ rc: { ...rc, startedAt: Date.now() }, userId: a.userId, role: a.role, sessionId: a.sessionId, opType: 'subscription', opName: msg?.payload?.operationName ?? field, fields: field, variables: msg?.payload?.variables, outcome: 'OK' });
                }
                return undefined;
              },
              onDisconnect: (ctx: any, code?: number) => {
                const rc = ctx.extra.rc;
                const a = ctx.extra.actor;
                if (rc && a) activity.record({ rc: { ...rc, startedAt: Date.now() }, userId: a.userId, role: a.role, sessionId: a.sessionId, opType: 'ws.disconnect', opName: 'liveFeed', outcome: 'OK', errorCode: code && code !== 1000 ? String(code) : null, durationMs: Date.now() - rc.startedAt });
              },
            },
          },
          context: (args: { req?: Request; res?: Response; extra?: any }): GqlContext => {
            if (args.extra) {
              // WebSocket subscription
              const req = args.extra.request as Request;
              return {
                req,
                actor: args.extra.actor,
                ip: req ? clientIp(req) : 'ws',
                userAgent: String(req?.headers?.['user-agent'] ?? ''),
                loaders: createLoaders(dbs.db),
              };
            }
            const req = args.req!;
            const authz = req.headers.authorization;
            return {
              req,
              res: args.res,
              ip: requestContext.get()?.ip ?? clientIp(req),
              userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
              bearer: typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7) : undefined,
              stepUpToken: typeof req.headers['x-step-up'] === 'string' ? req.headers['x-step-up'] : undefined,
              loaders: createLoaders(dbs.db),
            };
          },
        };
      },
    }),
    AuthGuardDeps,
  ],
  controllers: [HealthController, StatementController],
  providers: [
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    { provide: APP_GUARD, useClass: GqlAuthGuard },
    { provide: APP_PIPE, useValue: validationPipe },
    AuthResolver,
    StatementService,
    StatementResolver,
    ConsentResolver,
    MarketResolver,
    TradingResolver,
    OrderFieldsResolver,
    PositionFieldsResolver,
    PaymentsResolver,
    PaymentsService,
    UsersResolver,
    UsersService,
    AdminResolver,
    ReconciliationService,
    LogsResolver,
    LogMaintenanceService,
  ],
})
export class AppModule {}

export { GraphQLError };
