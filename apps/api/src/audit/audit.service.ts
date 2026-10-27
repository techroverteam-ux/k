import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { and, asc, desc, eq, gt, lt, sql, type SQL } from 'drizzle-orm';
import { DbService, type DbOrTx } from '../db/db';
import { auditEvents } from '../db/schema';
import type { Actor } from '../common/context';
import { requestContext } from '../common/request-context';

const GENESIS = '0'.repeat(64);
const SECRET_KEY_RE = /pass(word)?|otp|token|secret|pin|cvv|authorization|cookie/i;

export interface AuditInput {
  actor?: Pick<Actor, 'userId' | 'role'> | null;
  action: string;
  entityType?: string;
  entityId?: string;
  outcome: 'SUCCESS' | 'DENIED' | 'FAILURE';
  ip?: string;
  metadata?: Record<string, unknown>;
}

/** Remove anything that looks like a secret, and make BigInt JSON-safe. */
export function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitize(val, depth + 1);
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

/** Deterministic JSON (sorted keys) so hashes are reproducible. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function chainHash(prevHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update(canonical(body)).digest('hex');
}

/**
 * Append-only, hash-chained audit log. Each event's hash covers the previous hash,
 * so any edit or deletion breaks verification. The DB also blocks UPDATE/DELETE.
 * In production, also stream events to independent WORM storage (see docs/SECURITY.md).
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly dbs: DbService) {}

  /** Record inside the caller's transaction (so the audit row commits atomically with the change). */
  async record(tx: DbOrTx, e: AuditInput): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('td_audit_chain'))`);
    const [last] = await tx
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS;
    const createdAt = new Date();
    // Every event is stamped with the request's IP, device, session and request id (when it came from a request).
    const rc = requestContext.get();
    const body = {
      actorId: e.actor?.userId ?? null,
      actorRole: e.actor?.role ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId ?? null,
      outcome: e.outcome,
      ip: e.ip ?? rc?.ip ?? null,
      metadata: (sanitize(e.metadata ?? {}) as Record<string, unknown>) ?? {},
      createdAt: createdAt.toISOString(),
      // Added later: only part of the hash when present, so older rows still verify.
      userAgent: rc?.userAgent || undefined,
      sessionId: rc?.sessionId || undefined,
      requestId: rc?.requestId || undefined,
    };
    await tx.insert(auditEvents).values({ ...body, createdAt, prevHash, hash: chainHash(prevHash, body) });
  }

  /** Record in its own transaction (for denials/failures where the main tx rolled back). */
  async recordStandalone(e: AuditInput): Promise<void> {
    try {
      await this.dbs.db.transaction((tx) => this.record(tx, e));
    } catch (err) {
      this.log.error(`failed to write audit event ${e.action}: ${(err as Error).message}`);
    }
  }

  async list(opts: { limit: number; beforeSeq?: bigint; action?: string; actorId?: string; entityId?: string; requestId?: string; ip?: string }) {
    const where: SQL[] = [];
    if (opts.beforeSeq) where.push(lt(auditEvents.seq, opts.beforeSeq));
    if (opts.action) where.push(eq(auditEvents.action, opts.action));
    if (opts.actorId) where.push(eq(auditEvents.actorId, opts.actorId));
    if (opts.entityId) where.push(eq(auditEvents.entityId, opts.entityId));
    if (opts.requestId) where.push(eq(auditEvents.requestId, opts.requestId));
    if (opts.ip) where.push(eq(auditEvents.ip, opts.ip));
    return this.dbs.db
      .select()
      .from(auditEvents)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditEvents.seq))
      .limit(opts.limit);
  }

  /** Walk the whole chain and recompute hashes. Returns the first broken seq if any. */
  async verifyChain(): Promise<{ ok: boolean; checked: number; brokenAtSeq?: string }> {
    let prev = GENESIS;
    let after = 0n;
    let checked = 0;
    for (;;) {
      const batch = await this.dbs.db
        .select()
        .from(auditEvents)
        .where(gt(auditEvents.seq, after))
        .orderBy(asc(auditEvents.seq))
        .limit(1000);
      if (!batch.length) break;
      for (const r of batch) {
        const body = {
          actorId: r.actorId,
          actorRole: r.actorRole,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          outcome: r.outcome,
          ip: r.ip,
          metadata: r.metadata ?? {},
          createdAt: r.createdAt.toISOString(),
          userAgent: r.userAgent || undefined,
          sessionId: r.sessionId || undefined,
          requestId: r.requestId || undefined,
        };
        if (r.prevHash !== prev || chainHash(prev, body) !== r.hash) {
          return { ok: false, checked, brokenAtSeq: r.seq.toString() };
        }
        prev = r.hash;
        after = r.seq;
        checked++;
      }
    }
    return { ok: true, checked };
  }
}
