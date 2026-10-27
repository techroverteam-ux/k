import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { and, desc, eq, gte, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AppError, badInput } from '../common/errors';
import { requestContext } from '../common/request-context';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService } from '../db/db';
import { auditEvents, tradingConsents, users } from '../db/schema';

/** Audit actions that make up the sign-in history. */
export const LOGIN_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.mfa_failed',
  'auth.login_locked',
  'auth.login_inactive',
  'auth.refresh_reuse_detected',
  'auth.password_reset',
  'auth.password_reset_failed',
  'auth.session_revoked',
  'auth.sessions_revoked_all',
  'auth.password_changed',
  'auth.concurrent_login_detected',
  'auth.force_login',
  'auth.session_replaced',
  'auth.concurrent_login_blocked',
  'auth.sessions_revoked_by_admin',
] as const;

@Injectable()
export class ConsentService {
  constructor(
    private readonly dbs: DbService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** The rules currently shown, and a SHA-256 "version" of their exact text. */
  async currentTerms() {
    const rules = await this.config.get('ui.termsRules');
    const version = createHash('sha256').update(JSON.stringify(rules)).digest('hex');
    return { rules, version };
  }

  /** Traders must accept the current rules once per signed-in session before they can trade. */
  async status(actor: Actor) {
    const { rules, version } = await this.currentTerms();
    if (actor.role !== 'TRADER') return { required: false, termsVersion: version, rules, acceptedAt: undefined };
    const [c] = await this.dbs.db
      .select({ at: tradingConsents.acceptedAt })
      .from(tradingConsents)
      .where(and(eq(tradingConsents.sessionId, actor.sessionId), eq(tradingConsents.termsVersion, version)))
      .limit(1);
    return { required: !c, termsVersion: version, rules, acceptedAt: c?.at };
  }

  /** Throws unless this session has accepted the current rules (traders only). */
  async assertConsented(actor: Actor) {
    if (actor.role !== 'TRADER') return;
    if ((await this.status(actor)).required)
      throw new AppError('FORBIDDEN', 'Please read and accept the trading rules for this session before placing orders.', { reason: 'CONSENT_REQUIRED' });
  }

  async accept(actor: Actor, termsVersion: string, ip: string) {
    const { rules, version } = await this.currentTerms();
    if (termsVersion !== version) throw new AppError('CONFLICT', 'The rules were just updated. Please read the latest version and accept again.', { reason: 'TERMS_CHANGED' });
    const rc = requestContext.get();
    return this.dbs.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tradingConsents)
        .values({ userId: actor.userId, sessionId: actor.sessionId, termsVersion: version, termsText: rules, ip: rc?.ip ?? ip, userAgent: rc?.userAgent || null, client: rc?.client ?? null, requestId: rc?.requestId ?? null })
        .onConflictDoNothing()
        .returning();
      const rec = row ?? (await tx.select().from(tradingConsents).where(and(eq(tradingConsents.sessionId, actor.sessionId), eq(tradingConsents.termsVersion, version))))[0];
      if (row) {
        await tx.update(users).set({ termsAcceptedAt: rec.acceptedAt }).where(eq(users.id, actor.userId));
        await this.audit.record(tx, { actor, action: 'consent.accepted', entityType: 'trading_consent', entityId: rec.id, outcome: 'SUCCESS', ip, metadata: { termsVersion: version, rules: rules.length } });
      }
      return rec;
    });
  }

  listConsents(f: { userId?: string; ip?: string; from?: Date; to?: Date; beforeAt?: Date; limit: number }) {
    const where: (SQL | undefined)[] = [
      f.userId ? eq(tradingConsents.userId, f.userId) : undefined,
      f.ip ? eq(tradingConsents.ip, f.ip) : undefined,
      f.from ? gte(tradingConsents.acceptedAt, f.from) : undefined,
      f.to ? lte(tradingConsents.acceptedAt, f.to) : undefined,
      f.beforeAt ? lt(tradingConsents.acceptedAt, f.beforeAt) : undefined,
    ];
    return this.dbs.db
      .select({ c: tradingConsents, username: users.username, displayName: users.displayName })
      .from(tradingConsents)
      .innerJoin(users, eq(users.id, tradingConsents.userId))
      .where(and(...where))
      .orderBy(desc(tradingConsents.acceptedAt))
      .limit(f.limit);
  }

  loginEvents(f: { userId?: string; ip?: string; outcome?: string; from?: Date; to?: Date; beforeSeq?: bigint; limit: number }) {
    if (f.outcome && !['SUCCESS', 'FAILURE', 'DENIED'].includes(f.outcome)) throw badInput('Outcome must be SUCCESS, FAILURE or DENIED.');
    const where: (SQL | undefined)[] = [
      inArray(auditEvents.action, [...LOGIN_ACTIONS]),
      f.userId ? eq(auditEvents.actorId, f.userId) : undefined,
      f.ip ? eq(auditEvents.ip, f.ip) : undefined,
      f.outcome ? eq(auditEvents.outcome, f.outcome) : undefined,
      f.from ? gte(auditEvents.createdAt, f.from) : undefined,
      f.to ? lte(auditEvents.createdAt, f.to) : undefined,
      f.beforeSeq ? lt(auditEvents.seq, f.beforeSeq) : undefined,
    ];
    return this.dbs.db
      .select({ e: auditEvents, username: users.username, role: sql<string | null>`${users.role}::text` })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(and(...where))
      .orderBy(desc(auditEvents.seq))
      .limit(f.limit);
  }
}
