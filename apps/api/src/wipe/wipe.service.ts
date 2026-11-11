import { Injectable } from '@nestjs/common';
import { soleAdminMayApprove } from '../common/maker-checker';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AppError, badInput, notFound } from '../common/errors';
import { formatMoney } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DbService, type DbOrTx, type Tx } from '../db/db';
import {
  accountResetRequests, accountWipes, configVersions, deviceCredentials, feePayments, instruments, journalEntries, ledgerAccounts, ledgerPostings, notifications, orders,
  otpChallenges, payeeAccounts, paymentRequests, platformWipes, positions, reconciliationRuns, sessions, strategies, strategyEvents, strategyRuns, tradingConsents, users, watchlistItems,
} from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MarketDataService } from '../market/market-data.service';
import { ConfigService } from '../config-mgmt/config.service';

export const WIPE_CONFIRM = 'WIPE';
export const PLATFORM_WIPE_CONFIRM = 'WIPE ALL DATA';
const PLATFORM_WIPE_TTL_MS = 30 * 60_000;
const DELETE_REASON = (r: string) => { const why = r.trim(); if (why.length < 10 || why.length > 300) throw badInput('Give a reason (10–300 characters).'); return why; };

const jsonSafe = (rows: unknown) => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Owner resets require staff approval. A broker reset changes only that broker's visibility.
 * A trader reset preserves all history for staff, posts a zero-balance adjustment, archives
 * watchlist/position snapshots and disables the trader until the assigned broker or an admin re-enables it.
 * Full platform wipes hard-delete operational data only after a different Super Admin approves
 * within 30 minutes. The immutable audit/request logs and Super Admin accounts remain.
 */
/**
 * Permanently delete these accounts and everything they own. Must run inside a transaction that has
 * `SET LOCAL td.platform_wipe = 'on'` (the only way ledger and consent rows can be deleted). The audit log is never touched.
 * Adds the deleted accounts' session ids to `signedOut` so their open devices can be told to leave.
 */
export async function purgeAccounts(tx: Tx, targets: string[], signedOut: string[]): Promise<Record<string, number>> {
  const n = (rows: unknown[]) => rows.length;
  const counts: Record<string, number> = { accounts: targets.length };
  if (!targets.length) return counts;
  const sess = await tx.select({ id: sessions.id }).from(sessions).where(inArray(sessions.userId, targets));
  signedOut.push(...sess.map((s) => s.id));
  const accts = (await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(inArray(ledgerAccounts.ownerId, targets))).map((a) => a.id);
  const journals = accts.length
    ? (await tx.selectDistinct({ id: ledgerPostings.journalId }).from(ledgerPostings).where(inArray(ledgerPostings.accountId, accts))).map((j) => j.id)
    : [];
  counts.strategyEvents = n(await tx.delete(strategyEvents).where(inArray(strategyEvents.userId, targets)).returning({ id: strategyEvents.id }));
  counts.strategyRuns = n(await tx.delete(strategyRuns).where(inArray(strategyRuns.userId, targets)).returning({ id: strategyRuns.id }));
  counts.strategies = n(await tx.delete(strategies).where(inArray(strategies.userId, targets)).returning({ id: strategies.id }));
  counts.orders = n(await tx.delete(orders).where(inArray(orders.userId, targets)).returning({ id: orders.id }));
  counts.positions = n(await tx.delete(positions).where(inArray(positions.userId, targets)).returning({ id: positions.id }));
  counts.paymentRequests = n(await tx.delete(paymentRequests).where(inArray(paymentRequests.userId, targets)).returning({ id: paymentRequests.id }));
  for (let i = 0; i < journals.length; i += 5000) {
    const part = journals.slice(i, i + 5000);
    counts.ledgerPostings = (counts.ledgerPostings ?? 0) + n(await tx.delete(ledgerPostings).where(inArray(ledgerPostings.journalId, part)).returning({ id: ledgerPostings.id }));
  }
  for (let i = 0; i < journals.length; i += 5000) {
    const part = journals.slice(i, i + 5000);
    await tx.update(paymentRequests).set({ journalId: null }).where(inArray(paymentRequests.journalId, part));
    counts.journals = (counts.journals ?? 0) + n(await tx.delete(journalEntries).where(inArray(journalEntries.id, part)).returning({ id: journalEntries.id }));
  }
  if (accts.length) await tx.delete(ledgerAccounts).where(inArray(ledgerAccounts.id, accts));
  counts.consents = n(await tx.delete(tradingConsents).where(inArray(tradingConsents.userId, targets)).returning({ id: tradingConsents.id }));
  counts.feePayments = n(await tx.delete(feePayments).where(inArray(feePayments.userId, targets)).returning({ id: feePayments.id }));
  await tx.delete(accountResetRequests).where(inArray(accountResetRequests.userId, targets));
  counts.watchlistItems = n(await tx.delete(watchlistItems).where(inArray(watchlistItems.userId, targets)).returning({ id: watchlistItems.id }));
  counts.notifications = n(await tx.delete(notifications).where(inArray(notifications.userId, targets)).returning({ id: notifications.id }));
  await tx.delete(deviceCredentials).where(inArray(deviceCredentials.userId, targets));
  await tx.delete(accountWipes).where(inArray(accountWipes.userId, targets));
  await tx.delete(sessions).where(inArray(sessions.userId, targets));
  // Traders assigned to a deleted broker stay, unassigned.
  await tx.update(users).set({ brokerId: null }).where(inArray(users.brokerId, targets));
  await tx.update(users).set({ brokerId: null }).where(inArray(users.id, targets));
  await tx.delete(users).where(inArray(users.id, targets));
  return counts;
}

/**
 * After the accounts are gone: everything else except the Super Admin accounts and the append-only audit and
 * request logs. Settings go back to their defaults; payment details, market data and the platform's own ledger
 * accounts are deleted. Must run inside a transaction with `SET LOCAL td.platform_wipe = 'on'`.
 */
export async function clearPlatformData(tx: Tx): Promise<Record<string, number>> {
  const n = (rows: unknown[]) => rows.length;
  const c: Record<string, number> = {};
  c.feePayments = n(await tx.delete(feePayments).returning({ id: feePayments.id }));
  c.payeeAccounts = n(await tx.delete(payeeAccounts).returning({ id: payeeAccounts.id }));
  c.settings = n(await tx.delete(configVersions).returning({ id: configVersions.id }));
  c.candles = 0; // Candles are transient, never persisted.
  c.instruments = n(await tx.delete(instruments).returning({ id: instruments.id }));
  c.reconciliationRuns = n(await tx.delete(reconciliationRuns).returning({ id: reconciliationRuns.id }));
  await tx.delete(ledgerPostings);
  await tx.delete(journalEntries);
  await tx.delete(ledgerAccounts);
  await tx.delete(notifications);
  await tx.delete(accountWipes);
  await tx.delete(otpChallenges);
  return c;
}

@Injectable()
export class WipeService {
  constructor(
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly market: MarketDataService,
    private readonly config: ConfigService,
  ) {}

  private async self(actor: Actor) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, actor.userId));
    if (!u) throw notFound('Account');
    if (u.role === 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Super Admins use “Wipe all trading data” instead.');
    if (u.status !== 'ACTIVE') throw new AppError('FORBIDDEN', 'This account is not active.');
    return u;
  }

  private async openingBalance(db: DbOrTx, cash: string): Promise<bigint> {
    const [r] = await db
      .select({ s: sql<string>`COALESCE(SUM(${ledgerPostings.amountMinor}),0)::text` })
      .from(ledgerPostings)
      .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
      .where(and(eq(ledgerPostings.accountId, cash), eq(journalEntries.kind, 'OPENING_BALANCE')));
    return BigInt(r?.s ?? '0');
  }

  /** What a wipe would do, for the confirmation screen. */
  async preview(actor: Actor) {
    const u = await this.self(actor);
    const cash = await this.ledger.cashAccount(this.dbs.db, u.id, u.mode);
    const [balance, opening, pos, [{ n: openOrders }], [{ n: running }], [{ n: pending }]] = await Promise.all([
      this.ledger.balance(this.dbs.db, cash),
      this.openingBalance(this.dbs.db, cash),
      this.dbs.db.select({ netQty: positions.netQty }).from(positions).where(eq(positions.userId, u.id)),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.userId, u.id), eq(orders.status, 'OPEN'))),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(strategies).where(and(eq(strategies.userId, u.id), eq(strategies.status, 'RUNNING'))),
      this.dbs.db.select({ n: sql<number>`count(*)::int` }).from(paymentRequests).where(and(eq(paymentRequests.userId, u.id), eq(paymentRequests.status, 'REQUESTED'))),
    ]);
    const method = 'SESSION';
    return { balance: formatMoney(balance), resetTo: u.role === 'TRADER' ? '0.00' : formatMoney(balance), openPositions: pos.filter((p) => p.netQty !== 0).length, openOrders, runningStrategies: running, pendingRequests: pending, method };
  }

  async begin(actor: Actor, ip: string) {
    const u = await this.self(actor);
    const r = await this.auth.beginChallenge(u, 'wipe', ip);
    await this.audit.recordStandalone({ actor, action: 'account.wipe_started', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip, metadata: { method: r.method } });
    return r;
  }

  /** Legacy endpoint now queues a request; it can never bypass approval. */
  async wipeSelf(actor: Actor, code: string, confirm: string, ip: string) {
    const r = await this.requestAccountReset(actor, 'Owner requested an account reset.', confirm, ip);
    return { wipeId: r.id, balance: '0.00', status: 'PENDING' };
  }

  async requestAccountReset(actor: Actor, reason: string, confirm: string, ip: string) {
    if (confirm.trim().toUpperCase() !== WIPE_CONFIRM) throw badInput('Type WIPE to confirm.');
    const why = DELETE_REASON(reason);
    const u = await this.self(actor);
    return this.dbs.serializable(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, u.id)).for('update');
      if (!current || current.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This account is no longer active.');
      await tx.update(accountResetRequests).set({ status: 'EXPIRED' }).where(and(eq(accountResetRequests.userId, u.id), eq(accountResetRequests.status, 'PENDING'), sql`${accountResetRequests.expiresAt} <= now()`));
      const [pending] = await tx.select().from(accountResetRequests).where(and(eq(accountResetRequests.userId, u.id), eq(accountResetRequests.status, 'PENDING')));
      if (pending) throw new AppError('CONFLICT', 'A reset request is already waiting for approval.');
      const [r] = await tx.insert(accountResetRequests).values({ userId: u.id, requestedById: u.id, brokerId: u.brokerId, reason: why, expiresAt: new Date(Date.now() + PLATFORM_WIPE_TTL_MS) }).returning();
      const recipients = await this.resetRecipients(tx, u);
      for (const recipient of recipients) await this.notifications.notify(tx, recipient, 'account.reset_requested', 'Account reset approval requested', `${u.username} requested a reset. ${u.role === 'TRADER' ? 'Approval disables this trader and resets the balance to zero. Staff retain all history.' : "Only this broker's view is cleared; traders are unchanged."} Approve within 30 minutes.`);
      await this.audit.record(tx, { actor, action: 'account.reset_requested', entityType: 'account_reset', entityId: r.id, outcome: 'SUCCESS', ip });
      return r;
    });
  }

  private async resetRecipients(tx: DbOrTx, u: { id: string; role: string; brokerId: string | null }): Promise<string[]> {
    const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
    return [...new Set([...admins.map((a) => a.id), ...(u.role === 'TRADER' && u.brokerId ? [u.brokerId] : [])])];
  }

  async listAccountResets(actor: Actor) {
    const scope = actor.role === 'SUPER_ADMIN' ? undefined : actor.role === 'BROKER' ? sql`(${accountResetRequests.userId} = ${actor.userId} OR ${users.brokerId} = ${actor.userId})` : eq(accountResetRequests.userId, actor.userId);
    const rows = await this.dbs.db.select({ request: accountResetRequests, username: users.username, role: users.role, brokerId: users.brokerId }).from(accountResetRequests).innerJoin(users, eq(users.id, accountResetRequests.userId)).where(scope).orderBy(desc(accountResetRequests.createdAt)).limit(100);
    return rows.map(({ request, username, role, brokerId }) => ({ ...request, username, role, status: request.status === 'PENDING' && request.expiresAt <= new Date() ? 'EXPIRED' : request.status, canApprove: request.status === 'PENDING' && request.expiresAt > new Date() && request.userId !== actor.userId && (actor.role === 'SUPER_ADMIN' || (actor.role === 'BROKER' && role === 'TRADER' && brokerId === actor.userId)) }));
  }

  async decideAccountReset(actor: Actor, id: string, approve: boolean, ip: string) {
    let signedOut: string[] = [];
    const result = await this.dbs.serializable(async (tx) => {
      signedOut = [];
      const [r] = await tx.select().from(accountResetRequests).where(eq(accountResetRequests.id, id)).for('update');
      if (!r || r.status !== 'PENDING') throw notFound('Pending reset request');
      const [u] = await tx.select().from(users).where(eq(users.id, r.userId)).for('update');
      if (!u) throw notFound('Account');
      const allowed = actor.role === 'SUPER_ADMIN' || (actor.role === 'BROKER' && u.role === 'TRADER' && u.brokerId === actor.userId);
      if (!allowed || actor.userId === u.id) throw new AppError('FORBIDDEN', "Only a Super Admin or this trader's assigned broker may decide this request.");
      if (r.expiresAt <= new Date()) { await tx.update(accountResetRequests).set({ status: 'EXPIRED' }).where(eq(accountResetRequests.id, id)); return null; }
      if (approve && u.status !== 'ACTIVE') throw new AppError('CONFLICT', 'The account must be active before its reset can be approved.');
      if (approve && u.role === 'TRADER') {
      const cash = await this.ledger.cashAccount(tx, u.id, u.mode);
      await this.ledger.lock(tx, cash); // no order can fill while we reset
      const pos = await tx.select({ p: positions, symbol: instruments.symbol }).from(positions).innerJoin(instruments, eq(instruments.id, positions.instrumentId)).where(eq(positions.userId, u.id));
      if (pos.some((r) => r.p.netQty !== 0)) throw new AppError('CONFLICT', 'Exit your open positions first, then wipe out.');
      const wl = await tx.select({ listIndex: watchlistItems.listIndex, symbol: instruments.symbol, instrumentId: watchlistItems.instrumentId }).from(watchlistItems).innerJoin(instruments, eq(instruments.id, watchlistItems.instrumentId)).where(and(eq(watchlistItems.userId, u.id), isNull(watchlistItems.archivedAt)));
      const now = new Date();
      const cancelled = await tx.update(orders).set({ status: 'CANCELLED', rejectReason: 'Cancelled: account wiped out', updatedAt: now }).where(and(eq(orders.userId, u.id), eq(orders.status, 'OPEN'))).returning({ id: orders.id });
      const stopped = await tx.update(strategies).set({ status: 'STOPPED', stoppedAt: now, stopReason: 'Account wiped out' }).where(and(eq(strategies.userId, u.id), eq(strategies.status, 'RUNNING'))).returning({ id: strategies.id });
      const requests = await tx.update(paymentRequests).set({ status: 'CANCELLED', reviewNote: 'Cancelled: account wiped out', updatedAt: now }).where(and(eq(paymentRequests.userId, u.id), eq(paymentRequests.status, 'REQUESTED'))).returning({ id: paymentRequests.id });
      // Closed position summaries and the watchlist are archived in the snapshot; retain the rows.
      await tx.update(positions).set({ netQty: 0, avgPriceMinor: 0n, realizedPnlMinor: 0n, updatedAt: now }).where(eq(positions.userId, u.id));
      await tx.update(watchlistItems).set({ archivedAt: now }).where(eq(watchlistItems.userId, u.id));

      const before = await this.ledger.balance(tx, cash);
      const target = 0n;
      const [w] = await tx.insert(accountWipes).values({
        userId: u.id, byId: actor.userId, verifiedWith: 'APPROVAL', balanceBeforeMinor: before, balanceAfterMinor: target, ip,
        snapshot: jsonSafe({ positions: pos.map((r) => ({ ...r.p, symbol: r.symbol })), watchlist: wl, cancelledOrders: cancelled.map((c) => c.id), stoppedStrategies: stopped.map((s) => s.id), cancelledRequests: requests.map((r) => r.id) }),
      }).returning();
      let journalId: string | null = null;
      const diff = target - before;
      if (diff !== 0n) {
        const adj = await this.ledger.systemAccount(tx, 'ADJUSTMENT', u.mode);
        const j = await this.ledger.post(tx, {
          idempotencyKey: `wipe:${w.id}`, kind: 'ADJUSTMENT', mode: u.mode, createdById: actor.userId, refType: 'account_wipe', refId: w.id,
          memo: `Account wiped out: balance reset to ₹${formatMoney(target)}`,
          postings: [{ accountId: cash, amountMinor: diff }, { accountId: adj, amountMinor: -diff }],
        });
        journalId = j.id;
        await tx.update(accountWipes).set({ journalId }).where(eq(accountWipes.id, w.id));
      }

        const live = await tx.update(sessions).set({ revokedAt: now, revokedReason: 'account_reset' }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt))).returning({ id: sessions.id });
        signedOut.push(...live.map((s) => s.id));
        await this.auth.revokeTrustedDevices(tx, u.id, 'account_reset');
        await tx.update(users).set({ dataSince: sql`now()`, resetDisabledAt: now, status: 'SUSPENDED', riskState: 'OK', updatedAt: now }).where(eq(users.id, u.id));
      } else if (approve) {
        // Broker reset is a visibility change only; never mutate assigned traders or their ledger.
        await tx.update(users).set({ dataSince: sql`now()`, updatedAt: new Date() }).where(eq(users.id, u.id));
      }
      const [decided] = await tx.update(accountResetRequests).set({ status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.userId, decidedAt: new Date() }).where(eq(accountResetRequests.id, id)).returning();
      const recipients = new Set([u.id, ...(await this.resetRecipients(tx, u))]);
      for (const recipient of recipients) await this.notifications.notify(tx, recipient, 'account.reset_decided', `Account reset ${approve ? 'approved' : 'rejected'}`, `${u.username}: ${actor.role === 'BROKER' ? 'the assigned broker' : 'a Super Admin'} ${approve ? 'approved' : 'rejected'} the request.${approve && u.role === 'TRADER' ? ' The trader is disabled and can be re-enabled with a fresh zero balance. Historical records remain available to staff.' : ''}`);
      await this.audit.record(tx, { actor, action: approve ? 'account.reset_approved' : 'account.reset_rejected', entityType: 'account_reset', entityId: id, outcome: 'SUCCESS', ip, metadata: { userId: u.id } });
      return decided;
    });
    if (!result) throw new AppError('CONFLICT', 'This request expired. Ask for a new one.');
    if (signedOut.length) await this.auth.announceSignedOut(signedOut, 'Your account was disabled after an approved reset. Contact your broker or a Super Admin to re-enable it.');
    return result;
  }

  /** Super Admin: a user's wipes, with what was cleared. */
  async listForUser(userId: string, actor: Actor) {
    if (actor.role !== 'SUPER_ADMIN') {
      const [u] = await this.dbs.db.select().from(users).where(eq(users.id, userId));
      if (actor.role !== 'BROKER' || !u || u.brokerId !== actor.userId) throw notFound('Account');
    }
    return this.dbs.db.select().from(accountWipes).where(eq(accountWipes.userId, userId)).orderBy(desc(accountWipes.createdAt)).limit(50);
  }

  // ------------------------------------------------------------------ Super Admin: wipe all trading data

  async getWipe(id: string) {
    const [r] = await this.dbs.db.select().from(platformWipes).where(eq(platformWipes.id, id));
    if (!r) throw notFound('Request');
    return r;
  }

  listPlatform() {
    return this.dbs.db.select().from(platformWipes).where(isNull(platformWipes.targetUserId)).orderBy(desc(platformWipes.createdAt)).limit(20);
  }

  async requestPlatform(actor: Actor, reason: string, confirm: string, ip: string) {
    if (actor.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Super Admin access required.');
    if (confirm.trim() !== PLATFORM_WIPE_CONFIRM) throw badInput(`Type ${PLATFORM_WIPE_CONFIRM} to confirm.`);
    const why = reason.trim();
    if (why.length < 10 || why.length > 300) throw badInput('Give a reason (10–300 characters).');
    return this.dbs.serializable(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('platform-wipe'))`);
      await tx.update(platformWipes).set({ status: 'EXPIRED' }).where(and(eq(platformWipes.status, 'PENDING'), sql`${platformWipes.expiresAt} < now()`));
      const [open] = await tx.select({ id: platformWipes.id }).from(platformWipes).where(and(eq(platformWipes.status, 'PENDING'), isNull(platformWipes.targetUserId))).limit(1);
      if (open) throw new AppError('CONFLICT', 'A wipe request is already waiting for approval.');
      const [r] = await tx.insert(platformWipes).values({ requestedById: actor.userId, requestedIp: ip, reason: why, expiresAt: new Date(Date.now() + PLATFORM_WIPE_TTL_MS) }).returning();
      await this.audit.record(tx, { actor, action: 'platform.wipe_requested', entityType: 'platform_wipe', entityId: r.id, outcome: 'SUCCESS', ip, metadata: { reason: why } });
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, actor.userId)));
      for (const a of admins) await this.notifications.notify(tx, a.id, 'platform.wipe_requested', 'Approval needed: wipe all trading data', `A Super Admin asked to permanently delete all trader and broker data. Reason: ${why}. It expires in 30 minutes.`);
      return r;
    });
  }

  async rejectPlatform(actor: Actor, id: string, ip: string) {
    const [r] = await this.dbs.db.update(platformWipes).set({ status: 'REJECTED', decidedById: actor.userId, decidedIp: ip, decidedAt: new Date() }).where(and(eq(platformWipes.id, id), eq(platformWipes.status, 'PENDING'), isNull(platformWipes.targetUserId))).returning();
    if (!r) throw notFound('Wipe request');
    await this.audit.recordStandalone({ actor, action: r.requestedById === actor.userId ? 'platform.wipe_cancelled' : 'platform.wipe_rejected', entityType: 'platform_wipe', entityId: id, outcome: 'SUCCESS', ip });
    return r;
  }

  async approvePlatform(actor: Actor, id: string, confirm: string, ip: string) {
    if (actor.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Super Admin access required.');
    if (confirm.trim() !== PLATFORM_WIPE_CONFIRM) throw badInput(`Type ${PLATFORM_WIPE_CONFIRM} to confirm.`);
    const signedOut: string[] = [];
    const result = await this.dbs.serializable(async (tx) => {
      signedOut.length = 0;
      const [r] = await tx.select().from(platformWipes).where(and(eq(platformWipes.id, id), isNull(platformWipes.targetUserId))).for('update');
      if (!r || r.status !== 'PENDING') throw notFound('Wipe request');
      if (r.expiresAt <= new Date()) {
        await tx.update(platformWipes).set({ status: 'EXPIRED' }).where(eq(platformWipes.id, id));
        return null;
      }
      if (r.requestedById === actor.userId) throw new AppError('FORBIDDEN', 'A different Super Admin has to approve this.');

      // The one place append-only ledger and consent rows may be deleted (see migration 0013). Never the audit log.
      await tx.execute(sql`SET LOCAL td.platform_wipe = 'on'`);
      const targets = (await tx.select({ id: users.id }).from(users).where(ne(users.role, 'SUPER_ADMIN'))).map((x) => x.id);
      const counts = await this.purge(tx, targets, signedOut);
      Object.assign(counts, await clearPlatformData(tx));
      await tx.update(platformWipes).set({ status: 'EXECUTED', decidedById: actor.userId, decidedIp: ip, decidedAt: new Date(), summary: counts }).where(eq(platformWipes.id, id));
      await this.audit.record(tx, { actor, action: 'platform.wiped', entityType: 'platform_wipe', entityId: id, outcome: 'SUCCESS', ip, metadata: { requestedBy: r.requestedById, reason: r.reason, ...counts } });
      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'SUPER_ADMIN'));
      for (const admin of admins) await this.notifications.notify(tx, admin.id, 'platform.wipe_completed', 'Full wipe approved and completed', `A different Super Admin approved the request. ${counts.accounts} broker/trader accounts were permanently deleted.`);
      return counts;
    });
    if (!result) throw new AppError('CONFLICT', 'This request expired. Ask for a new one.');
    // Tell the deleted accounts' open devices to leave now, and drop cached settings and market data.
    await this.auth.announceSignedOut(signedOut, 'Your account no longer exists.');
    this.config.invalidate();
    await this.market.clearAll();
    return result;
  }

  private purge(tx: Tx, targets: string[], signedOut: string[]) {
    return purgeAccounts(tx, targets, signedOut);
  }

  // ---------------------------------------------------------------- delete one account permanently
  listUserDeletions(userId?: string) {
    return this.dbs.db.select().from(platformWipes)
      .where(userId ? eq(platformWipes.targetUserId, userId) : isNotNull(platformWipes.targetUserId))
      .orderBy(desc(platformWipes.createdAt)).limit(50);
  }

  /** One Super Admin asks to delete a trader or broker for good; confirm = the account's username. */
  async requestUserDeletion(actor: Actor, userId: string, reason: string, confirm: string, ip: string) {
    const why = DELETE_REASON(reason);
    return this.dbs.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id, username: users.username, role: users.role, displayName: users.displayName }).from(users).where(eq(users.id, userId));
      if (!u) throw notFound('Account');
      if (u.role === 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Super Admin accounts can’t be deleted here.');
      if (confirm.trim().toLowerCase() !== u.username) throw badInput(`Type the username ${u.username} to confirm.`);
      await tx.update(platformWipes).set({ status: 'EXPIRED' }).where(and(eq(platformWipes.status, 'PENDING'), sql`${platformWipes.expiresAt} < now()`));
      const [open] = await tx.select({ id: platformWipes.id }).from(platformWipes).where(and(eq(platformWipes.status, 'PENDING'), eq(platformWipes.targetUserId, userId))).limit(1);
      if (open) throw new AppError('CONFLICT', 'A delete request for this account is already waiting for approval.');
      const [r] = await tx.insert(platformWipes).values({ targetUserId: u.id, targetUsername: u.username, targetRole: u.role, requestedById: actor.userId, requestedIp: ip, reason: why, expiresAt: new Date(Date.now() + PLATFORM_WIPE_TTL_MS) }).returning();
      await this.audit.record(tx, { actor, action: 'user.delete_requested', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip, metadata: { username: u.username, role: u.role, reason: why, request: r.id } });
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, actor.userId)));
      for (const a of admins) await this.notifications.notify(tx, a.id, 'user.delete_requested', `Approval needed: delete ${u.username}`, `A Super Admin asked to permanently delete ${u.displayName} (${u.username}) and all their data. Reason: ${why}. It expires in 30 minutes.`);
      return r;
    });
  }

  /** A different Super Admin approves: the account and all its data are deleted at once. confirm = the username. */
  async approveUserDeletion(actor: Actor, id: string, confirm: string, ip: string) {
    const signedOut: string[] = [];
    const result = await this.dbs.db.transaction(async (tx) => {
      const [r] = await tx.select().from(platformWipes).where(and(eq(platformWipes.id, id), isNotNull(platformWipes.targetUserId))).for('update');
      if (!r || r.status !== 'PENDING') throw notFound('Delete request');
      if (r.expiresAt < new Date()) {
        await tx.update(platformWipes).set({ status: 'EXPIRED' }).where(eq(platformWipes.id, id));
        throw new AppError('CONFLICT', 'This request expired. Ask for a new one.');
      }
      if (r.requestedById === actor.userId && !(await soleAdminMayApprove(tx))) throw new AppError('FORBIDDEN', 'A different Super Admin has to approve this.');
      if (confirm.trim().toLowerCase() !== r.targetUsername) throw badInput(`Type the username ${r.targetUsername} to confirm.`);
      const [u] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, r.targetUserId!)).for('update');
      if (!u) { await tx.update(platformWipes).set({ status: 'EXPIRED' }).where(eq(platformWipes.id, id)); throw notFound('Account'); }
      if (u.role === 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Super Admin accounts can’t be deleted here.');
      await tx.execute(sql`SET LOCAL td.platform_wipe = 'on'`);
      const counts = await this.purge(tx, [u.id], signedOut);
      await tx.update(platformWipes).set({ status: 'EXECUTED', decidedById: actor.userId, decidedIp: ip, decidedAt: new Date(), summary: counts }).where(eq(platformWipes.id, id));
      await this.audit.record(tx, { actor, action: 'user.deleted', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip, metadata: { username: r.targetUsername, role: r.targetRole, requestedBy: r.requestedById, reason: r.reason, ...counts } });
      return counts;
    });
    await this.auth.announceSignedOut(signedOut, 'Your account no longer exists.');
    return result;
  }

  async rejectUserDeletion(actor: Actor, id: string, ip: string) {
    const [r] = await this.dbs.db.update(platformWipes).set({ status: 'REJECTED', decidedById: actor.userId, decidedIp: ip, decidedAt: new Date() }).where(and(eq(platformWipes.id, id), eq(platformWipes.status, 'PENDING'), isNotNull(platformWipes.targetUserId))).returning();
    if (!r) throw notFound('Delete request');
    await this.audit.recordStandalone({ actor, action: r.requestedById === actor.userId ? 'user.delete_cancelled' : 'user.delete_rejected', entityType: 'user', entityId: r.targetUserId!, outcome: 'SUCCESS', ip, metadata: { username: r.targetUsername } });
    return r;
  }
}
