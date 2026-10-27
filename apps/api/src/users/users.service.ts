import { emailColumns, emailIndex, normalizeEmail, normalizePhone, phoneColumns, phoneIndex } from '../common/pii';
import { Injectable } from '@nestjs/common';
import { and, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { badInput, conflict, forbidden, notFound } from '../common/errors';
import { applyBps } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService } from '../db/db';
import { journalEntries, ledgerAccounts, ledgerPostings, orders, paymentRequests, positions, sessions, users, type Role } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { MarketDataService } from '../market/market-data.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { OrdersService } from '../trading/orders.service';

export const USERNAME_RE = /^[a-z][a-z0-9_.]{3,39}$/;

@Injectable()
export class UsersService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly policy: PolicyService,
    private readonly ledger: LedgerService,
    private readonly orders: OrdersService,
    private readonly market: MarketDataService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(actor: Actor, userId: string, ip?: string) {
    await this.policy.assertCanAccessUser(actor, userId, ip);
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound('Account');
    return u;
  }

  async list(actor: Actor, f: { role?: Role; status?: string; search?: string; brokerId?: string; limit: number; offset: number }) {
    const where: (SQL | undefined)[] = [this.policy.userScope(actor)];
    if (f.role) where.push(eq(users.role, f.role));
    if (f.status) where.push(eq(users.status, f.status as any));
    if (f.brokerId) where.push(eq(users.brokerId, f.brokerId));
    if (f.search) {
      const s = `%${f.search.replace(/[%_\\]/g, (m) => '\\' + m).slice(0, 40)}%`;
      where.push(or(ilike(users.username, s), ilike(users.displayName, s)));
    }
    const cond = and(...where);
    const [items, [{ total }]] = await Promise.all([
      this.dbs.db.select().from(users).where(cond).orderBy(users.createdAt).limit(f.limit).offset(f.offset),
      this.dbs.db.select({ total: sql<number>`count(*)::int` }).from(users).where(cond),
    ]);
    return { items, total };
  }

  /**
   * Maker step. Super Admin can create brokers and traders; a broker can create traders under itself.
   * New accounts start PENDING and must be approved by a (different) Super Admin.
   */
  async create(actor: Actor, input: { username: string; displayName: string; role: Role; phone?: string; email?: string; brokerId?: string; tempPassword: string }, ip: string) {
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw badInput('Username: 4–40 chars, start with a letter, letters/digits/_/. only.');
    if (input.role === 'SUPER_ADMIN') throw forbidden('Super Admin accounts are provisioned by operations, not via the API.');
    if (actor.role === 'BROKER' && input.role !== 'TRADER') throw forbidden('Brokers can only create trader accounts.');
    const brokerId = actor.role === 'BROKER' ? actor.userId : input.role === 'TRADER' ? input.brokerId : undefined;
    this.passwords.assertStrong(input.tempPassword, username);
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const email = input.email ? normalizeEmail(input.email) : null;
    const hash = await this.passwords.hash(input.tempPassword);
    return this.dbs.serializable(async (tx) => {
      if (brokerId) {
        const [b] = await tx.select().from(users).where(and(eq(users.id, brokerId), eq(users.role, 'BROKER')));
        if (!b) throw badInput('Broker not found.');
      }
      const [exists] = await tx
        .select({ id: users.id })
        .from(users)
        .where(or(eq(users.username, username), phone ? eq(users.phoneHash, phoneIndex(phone)) : undefined, email ? eq(users.emailHash, emailIndex(email)) : undefined));
      if (exists) throw conflict('Username, phone or email is already in use.');
      const [u] = await tx
        .insert(users)
        .values({
          username,
          displayName: input.displayName.trim().slice(0, 120) || username,
          role: input.role,
          ...phoneColumns(phone),
          ...emailColumns(email),
          brokerId: brokerId ?? null,
          passwordHash: hash,
          status: 'PENDING',
          mode: 'SIMULATED',
          createdById: actor.userId,
        })
        .returning();
      await this.ledger.cashAccount(tx, u.id, 'SIMULATED');
      await this.audit.record(tx, { actor, action: 'user.created', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip, metadata: { username, role: input.role, brokerId } });
      return u;
    });
  }

  /** Checker step for account activation. */
  async approve(actor: Actor, userId: string, ip: string) {
    return this.dbs.serializable(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!u) throw notFound('Account');
      if (u.status !== 'PENDING') throw conflict(`Account is ${u.status.toLowerCase()}.`);
      if (u.createdById === actor.userId) {
        await this.audit.recordStandalone({ actor, action: 'user.self_approval_blocked', entityType: 'user', entityId: userId, outcome: 'DENIED', ip });
        throw forbidden('Maker-checker: another Super Admin must approve accounts you created.');
      }
      const [r] = await tx.update(users).set({ status: 'ACTIVE', updatedAt: new Date() }).where(eq(users.id, userId)).returning();
      await this.audit.record(tx, { actor, action: 'user.approved', entityType: 'user', entityId: userId, outcome: 'SUCCESS', ip, metadata: { createdBy: u.createdById } });
      return r;
    });
  }

  async setStatus(actor: Actor, userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED', reason: string, ip: string) {
    if (userId === actor.userId) throw forbidden('You cannot change your own status.');
    if (!reason || reason.trim().length < 5) throw badInput('Give a reason (min 5 characters).');
    return this.dbs.serializable(async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!u) throw notFound('Account');
      if (u.role === 'SUPER_ADMIN') throw forbidden('Super Admin status is managed by operations.');
      if (u.status === 'PENDING') throw badInput('Approve the account first.');
      const [r] = await tx.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId)).returning();
      if (status !== 'ACTIVE') {
        await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: `account_${status.toLowerCase()}` }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
        await tx.update(orders).set({ status: 'CANCELLED', updatedAt: new Date() }).where(and(eq(orders.userId, userId), eq(orders.status, 'OPEN')));
      }
      await this.audit.record(tx, { actor, action: `user.${status.toLowerCase()}`, entityType: 'user', entityId: userId, outcome: 'SUCCESS', ip, metadata: { from: u.status, reason } });
      return r;
    });
  }

  async assignBroker(actor: Actor, traderId: string, brokerId: string | null, ip: string) {
    return this.dbs.serializable(async (tx) => {
      const [t] = await tx.select().from(users).where(eq(users.id, traderId)).for('update');
      if (!t || t.role !== 'TRADER') throw notFound('Trader');
      if (brokerId) {
        const [b] = await tx.select().from(users).where(and(eq(users.id, brokerId), eq(users.role, 'BROKER')));
        if (!b) throw badInput('Broker not found.');
      }
      const [r] = await tx.update(users).set({ brokerId, updatedAt: new Date() }).where(eq(users.id, traderId)).returning();
      await this.audit.record(tx, { actor, action: 'user.broker_assigned', entityType: 'user', entityId: traderId, outcome: 'SUCCESS', ip, metadata: { from: t.brokerId, to: brokerId } });
      return r;
    });
  }

  async adminResetPassword(actor: Actor, userId: string, tempPassword: string, ip: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw notFound('Account');
    if (u.role === 'SUPER_ADMIN') throw forbidden('Super Admin credentials are reset by operations.');
    this.passwords.assertStrong(tempPassword, u.username);
    const hash = await this.passwords.hash(tempPassword);
    await this.dbs.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hash, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() }).where(eq(users.id, userId));
      await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'admin_password_reset' }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await this.audit.record(tx, { actor, action: 'user.password_reset', entityType: 'user', entityId: userId, outcome: 'SUCCESS', ip });
      await this.notifications.notify(tx, userId, 'security.password_reset', 'Password reset', 'An administrator reset your password. All devices were signed out.');
    });
    return true;
  }

  // ------------------------------------------------------------------ account summary

  async accountSummary(actor: Actor, userId: string, ip?: string) {
    const u = await this.get(actor, userId, ip);
    const cash = await this.ledger.cashAccount(this.dbs.db, userId, u.mode);
    const bps = await this.config.get('trading.intradayMarginBps');
    const [balance, marginUsed, totals, pos] = await Promise.all([
      this.ledger.balance(this.dbs.db, cash),
      this.dbs.db.transaction((tx) => this.orders.marginUsed(tx, userId, bps)),
      this.dbs.db
        .select({ kind: journalEntries.kind, s: sql<string>`COALESCE(SUM(${ledgerPostings.amountMinor}),0)::text` })
        .from(ledgerPostings)
        .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
        .where(eq(ledgerPostings.accountId, cash))
        .groupBy(journalEntries.kind),
      this.dbs.db.select().from(positions).where(eq(positions.userId, userId)),
    ]);
    const t = (k: string) => BigInt(totals.find((x) => x.kind === k)?.s ?? '0');
    let unrealized = 0n;
    let openPositions = 0;
    for (const p of pos) {
      if (p.netQty === 0) continue;
      openPositions++;
      const q = this.market.quote(p.instrumentId);
      if (!q) continue;
      const mark = p.netQty > 0 ? q.bidMinor : q.askMinor;
      unrealized += (mark - p.avgPriceMinor) * BigInt(p.netQty);
    }
    const [{ openOrders }] = await this.dbs.db
      .select({ openOrders: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.status, 'OPEN')));
    return {
      userId,
      mode: u.mode,
      balanceMinor: balance,
      marginUsedMinor: marginUsed,
      availableMinor: balance - marginUsed,
      depositsMinor: t('DEPOSIT'),
      withdrawalsMinor: -t('WITHDRAWAL'),
      realizedPnlMinor: t('TRADE_PNL'),
      feesMinor: -t('FEE'),
      unrealizedPnlMinor: unrealized,
      openPositions,
      openOrders,
    };
  }

  /** Realized P&L / brokerage / volume for a period. */
  async periodSummary(actor: Actor, userId: string, from: Date, to: Date) {
    const u = await this.get(actor, userId);
    const cash = await this.ledger.cashAccount(this.dbs.db, userId, u.mode);
    const rows = await this.dbs.db
      .select({ kind: journalEntries.kind, s: sql<string>`COALESCE(SUM(${ledgerPostings.amountMinor}),0)::text`, n: sql<number>`count(*)::int` })
      .from(ledgerPostings)
      .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
      .where(and(eq(ledgerPostings.accountId, cash), gte(ledgerPostings.createdAt, from), sql`${ledgerPostings.createdAt} < ${to}`))
      .groupBy(journalEntries.kind);
    const [vol] = await this.dbs.db
      .select({ v: sql<string>`COALESCE(SUM(${orders.fillPriceMinor} * ${orders.quantity}),0)::text`, n: sql<number>`count(*)::int` })
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.status, 'FILLED'), gte(orders.filledAt, from), sql`${orders.filledAt} < ${to}`));
    const g = (k: string) => rows.find((r) => r.kind === k);
    return {
      realizedPnlMinor: BigInt(g('TRADE_PNL')?.s ?? '0'),
      brokerageMinor: -BigInt(g('FEE')?.s ?? '0'),
      trades: vol.n,
      ledgerEntries: rows.reduce((a, r) => a + r.n, 0),
      volumeMinor: BigInt(vol.v),
    };
  }

  /** Broker commissions: broker's share of simulated brokerage from assigned traders. */
  async brokerCommission(actor: Actor, brokerId: string, from: Date, to: Date) {
    if (actor.role === 'BROKER' && actor.userId !== brokerId) throw notFound('Account');
    const share = await this.config.get('broker.commissionShareBps');
    const rows = await this.dbs.db
      .select({ userId: users.id, username: users.username, fees: sql<string>`COALESCE(-SUM(${ledgerPostings.amountMinor}),0)::text` })
      .from(users)
      .innerJoin(ledgerAccounts, and(eq(ledgerAccounts.ownerId, users.id), eq(ledgerAccounts.type, 'TRADER_CASH')))
      .innerJoin(ledgerPostings, eq(ledgerPostings.accountId, ledgerAccounts.id))
      .innerJoin(journalEntries, and(eq(journalEntries.id, ledgerPostings.journalId), eq(journalEntries.kind, 'FEE')))
      .where(and(eq(users.brokerId, brokerId), gte(ledgerPostings.createdAt, from), sql`${ledgerPostings.createdAt} < ${to}`))
      .groupBy(users.id, users.username);
    const lines = rows.map((r) => ({ userId: r.userId, username: r.username, brokerageMinor: BigInt(r.fees), commissionMinor: applyBps(BigInt(r.fees), share) }));
    return { shareBps: share, lines, totalMinor: lines.reduce((a, l) => a + l.commissionMinor, 0n) };
  }

  async adminOverview() {
    const db = this.dbs.db;
    const [byRole, [pendingPayments], [pendingUsers], [openOrders], [denials]] = await Promise.all([
      db.select({ role: users.role, status: users.status, c: sql<number>`count(*)::int` }).from(users).groupBy(users.role, users.status),
      db.select({ c: sql<number>`count(*)::int`, s: sql<string>`COALESCE(SUM(${paymentRequests.amountMinor}),0)::text` }).from(paymentRequests).where(eq(paymentRequests.status, 'REQUESTED')),
      db.select({ c: sql<number>`count(*)::int` }).from(users).where(eq(users.status, 'PENDING')),
      db.select({ c: sql<number>`count(*)::int` }).from(orders).where(eq(orders.status, 'OPEN')),
      db.execute<{ c: number }>(sql`SELECT count(*)::int AS c FROM audit_events WHERE outcome IN ('DENIED','FAILURE') AND created_at > now() - interval '24 hours'`).then((r) => r.rows),
    ]);
    const count = (role: string, status?: string) => byRole.filter((r) => r.role === role && (!status || r.status === status)).reduce((a, r) => a + r.c, 0);
    return {
      brokers: count('BROKER'),
      traders: count('TRADER'),
      activeTraders: count('TRADER', 'ACTIVE'),
      suspended: byRole.filter((r) => r.status === 'SUSPENDED').reduce((a, r) => a + r.c, 0),
      pendingAccounts: pendingUsers.c,
      pendingPayments: pendingPayments.c,
      pendingPaymentsMinor: BigInt(pendingPayments.s),
      openOrders: openOrders.c,
      securityEvents24h: denials.c,
    };
  }

  async brokersByIds(ids: string[]) {
    if (!ids.length) return [];
    return this.dbs.db.select().from(users).where(inArray(users.id, ids));
  }
}
