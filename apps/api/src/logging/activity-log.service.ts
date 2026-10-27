import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { maskPhone } from '../auth/sms.provider';
import { sanitize } from '../audit/audit.service';
import type { RequestContext } from '../common/request-context';
import { DbService } from '../db/db';
import { activityLog, users } from '../db/schema';
import { jsonLog } from './json-logger';

export interface ActivityInput {
  rc: RequestContext;
  userId?: string | null;
  role?: string | null;
  sessionId?: string | null;
  opType: 'query' | 'mutation' | 'subscription' | 'ws.connect' | 'ws.disconnect' | 'invalid' | 'http';
  opName?: string | null;
  fields?: string | null;
  variables?: Record<string, unknown> | null;
  outcome: 'OK' | 'ERROR';
  errorCode?: string | null;
  durationMs?: number | null;
}

const EXTRA_SECRET = /^(code|totp|mfaToken|refreshToken|tempPassword|newPassword|currentPassword|idempotencyKey_secret)$/i;
const MAX_VARS_BYTES = 2048;

/** Variables are useful ("which trader did the admin open?") but must never contain secrets. */
export function safeVariables(v: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!v || !Object.keys(v).length) return null;
  const walk = (x: unknown, depth = 0): unknown => {
    if (depth > 4) return '[depth]';
    if (Array.isArray(x)) return x.slice(0, 20).map((i) => walk(i, depth + 1));
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        if (EXTRA_SECRET.test(k)) o[k] = '[redacted]';
        else if (/^phone$/i.test(k) && typeof val === 'string') o[k] = maskPhone(val);
        else o[k] = walk(val, depth + 1);
      }
      return o;
    }
    return x;
  };
  const out = sanitize(walk(v)) as Record<string, unknown>;
  const s = JSON.stringify(out);
  return s.length > MAX_VARS_BYTES ? { truncated: true, preview: s.slice(0, MAX_VARS_BYTES) } : out;
}

/**
 * Writes one row per API operation. Rows are buffered and written in batches (≤ 0.5 s / 200 rows)
 * so logging never slows a trade down. If the database write fails, the rows are emitted to
 * stdout as JSON instead — they are never silently dropped.
 * Money/security events are ALSO in the hash-chained audit trail, written in the same
 * transaction as the change itself.
 */
@Injectable()
export class ActivityLogService implements OnModuleDestroy {
  private readonly log = new Logger('ActivityLog');
  private buffer: (typeof activityLog.$inferInsert)[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  readonly stats = { written: 0, fallback: 0 };

  constructor(private readonly dbs: DbService) {}

  record(e: ActivityInput) {
    const row = {
      at: new Date(e.rc.startedAt),
      requestId: e.rc.requestId,
      userId: e.userId ?? e.rc.userId ?? null,
      role: e.role ?? e.rc.role ?? null,
      sessionId: e.sessionId ?? e.rc.sessionId ?? null,
      ip: e.rc.ip,
      userAgent: e.rc.userAgent || null,
      client: e.rc.client,
      opType: e.opType,
      opName: e.opName?.slice(0, 120) ?? null,
      fields: e.fields?.slice(0, 400) ?? null,
      variables: safeVariables(e.variables),
      outcome: e.outcome,
      errorCode: e.errorCode?.slice(0, 40) ?? null,
      durationMs: e.durationMs ?? null,
    };
    this.buffer.push(row);
    if (process.env.LOG_REQUESTS_STDOUT === 'true') jsonLog('info', 'request', { ...row, at: row.at.toISOString(), variables: undefined });
    if (this.buffer.length >= 200) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 500);
  }

  /** Write everything buffered (also used by tests and on shutdown). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flushing) await this.flushing;
    const rows = this.buffer.splice(0);
    if (!rows.length) return;
    this.flushing = (async () => {
      try {
        for (let i = 0; i < rows.length; i += 500) await this.dbs.db.insert(activityLog).values(rows.slice(i, i + 500));
        this.stats.written += rows.length;
      } catch (err) {
        this.stats.fallback += rows.length;
        this.log.error(`activity log write failed (${(err as Error).message}); emitting ${rows.length} rows to stdout`);
        for (const r of rows) jsonLog('warn', 'activity_log_fallback', { ...r, at: r.at?.toISOString() });
      }
    })();
    await this.flushing;
    this.flushing = undefined;
  }

  async onModuleDestroy() {
    await this.flush();
  }

  // ---------------------------------------------------------------- reads

  async search(f: { userId?: string; ip?: string; opName?: string; outcome?: 'OK' | 'ERROR'; opTypes?: string[]; from?: Date; to?: Date; beforeId?: bigint; limit: number }) {
    const where: (SQL | undefined)[] = [
      f.userId ? eq(activityLog.userId, f.userId) : undefined,
      f.ip ? eq(activityLog.ip, f.ip) : undefined,
      f.opName ? eq(activityLog.opName, f.opName) : undefined,
      f.outcome ? eq(activityLog.outcome, f.outcome) : undefined,
      f.opTypes?.length ? inArray(activityLog.opType, f.opTypes) : undefined,
      f.from ? gte(activityLog.at, f.from) : undefined,
      f.to ? lte(activityLog.at, f.to) : undefined,
      f.beforeId ? lt(activityLog.id, f.beforeId) : undefined,
    ];
    return this.dbs.db
      .select({ a: activityLog, username: users.username })
      .from(activityLog)
      .leftJoin(users, eq(users.id, activityLog.userId))
      .where(and(...where))
      .orderBy(desc(activityLog.id))
      .limit(f.limit);
  }

  /** A user's own meaningful activity: sign-ins and every action (mutations), not background reads. */
  mine(userId: string, limit: number, beforeId?: bigint) {
    return this.dbs.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.userId, userId), eq(activityLog.opType, 'mutation'), sql`${activityLog.opName} IS DISTINCT FROM 'refresh'`, beforeId ? lt(activityLog.id, beforeId) : undefined))
      .orderBy(desc(activityLog.id))
      .limit(limit);
  }

  /** Accounts seen on one IP: a fraud signal (shared devices, multi-accounting). */
  async accountsOnIp(ip: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const r = await this.dbs.db.execute<{ user_id: string; username: string; role: string; requests: number; first_seen: Date; last_seen: Date }>(sql`
      SELECT a.user_id, u.username, u.role::text AS role, count(*)::int AS requests, min(a.at) AS first_seen, max(a.at) AS last_seen
        FROM activity_log a JOIN users u ON u.id = a.user_id
       WHERE a.ip = ${ip} AND a.at >= ${since} AND a.user_id IS NOT NULL
       GROUP BY a.user_id, u.username, u.role ORDER BY last_seen DESC LIMIT 100`);
    return r.rows;
  }

  /** IPs a user has used: helps spot account sharing or takeover. */
  async ipsForUser(userId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const r = await this.dbs.db.execute<{ ip: string; requests: number; first_seen: Date; last_seen: Date; other_accounts: number }>(sql`
      SELECT a.ip, count(*)::int AS requests, min(a.at) AS first_seen, max(a.at) AS last_seen,
             (SELECT count(DISTINCT b.user_id)::int FROM activity_log b WHERE b.ip = a.ip AND b.at >= ${since} AND b.user_id IS NOT NULL AND b.user_id <> ${userId}) AS other_accounts
        FROM activity_log a
       WHERE a.user_id = ${userId} AND a.at >= ${since}
       GROUP BY a.ip ORDER BY last_seen DESC LIMIT 50`);
    return r.rows;
  }
}
