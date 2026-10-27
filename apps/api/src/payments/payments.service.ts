import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AppError, badInput, conflict, forbidden, notFound } from '../common/errors';
import { formatMoney } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { DbService } from '../db/db';
import { paymentRequests, users, type PaymentRow } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PolicyService } from '../policy/policy.service';
import { OrdersService } from '../trading/orders.service';
import { requestContext } from '../common/request-context';

type PaymentStatus = PaymentRow['status'];

/**
 * Deposit / withdrawal requests with maker-checker approval.
 *
 * In SIMULATED mode, an approved request adjusts the VIRTUAL balance only — no money moves.
 * In LIVE mode (not enabled in this build), deposits must be confirmed by a payment-gateway
 * callback verified by signature and keyed by the gateway's idempotent reference, and
 * withdrawals go out through a licensed payout rail; see docs/PAYMENTS.md.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly dbs: DbService,
    private readonly ledger: LedgerService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
  ) {}

  async request(actor: Actor, input: { userId?: string; type: 'DEPOSIT' | 'WITHDRAWAL'; amountMinor: bigint; idempotencyKey: string; note?: string }, ip: string) {
    const userId = input.userId ?? actor.userId;
    if (actor.role === 'BROKER') {
      if (userId === actor.userId) throw forbidden('Brokers submit requests on behalf of their traders.');
      if (!(await this.config.get('payments.brokerMaySubmit'))) throw forbidden('Brokers may not submit payment requests.');
    }
    await this.policy.assertCanAccessUser(actor, userId, ip);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(input.idempotencyKey)) throw badInput('Invalid idempotency key.');
    if (input.amountMinor <= 0n) throw badInput('Amount must be greater than zero.');
    const maxKey = input.type === 'DEPOSIT' ? 'payments.maxDepositMinor' : 'payments.maxWithdrawalMinor';
    const max = BigInt(await this.config.get(maxKey));
    if (input.amountMinor > max) throw badInput(`Maximum per request is ₹${formatMoney(max)}.`);

    return this.dbs.serializable(async (tx) => {
      const [dup] = await tx
        .select()
        .from(paymentRequests)
        .where(and(eq(paymentRequests.requestedById, actor.userId), eq(paymentRequests.idempotencyKey, input.idempotencyKey)));
      if (dup) {
        if (dup.userId !== userId || dup.amountMinor !== input.amountMinor || dup.type !== input.type) throw conflict('Idempotency key reused with different details.');
        return dup;
      }
      const [u] = await tx.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== 'TRADER') throw notFound('Account');
      if (u.status !== 'ACTIVE') throw badInput('Account is not active.');

      if (input.type === 'WITHDRAWAL') {
        const cash = await this.ledger.cashAccount(tx, userId, u.mode);
        await this.ledger.lock(tx, cash);
        const available = await this.available(tx, userId, cash);
        if (input.amountMinor > available) throw new AppError('INSUFFICIENT_FUNDS', 'Amount exceeds your withdrawable balance.');
      }

      const [p] = await tx
        .insert(paymentRequests)
        .values({ userId, type: input.type, mode: u.mode, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey, requestedById: actor.userId, reviewNote: input.note?.slice(0, 500), requestedIp: requestContext.get()?.ip ?? ip, requestedUserAgent: requestContext.get()?.userAgent, requestedSessionId: actor.sessionId, requestId: requestContext.get()?.requestId })
        .returning();
      await this.audit.record(tx, { actor, action: `payment.${input.type.toLowerCase()}_requested`, entityType: 'payment', entityId: p.id, outcome: 'SUCCESS', ip, metadata: { userId, amount: input.amountMinor, mode: u.mode } });
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
      for (const a of admins) {
        await this.notifications.notify(tx, a.id, 'payment.review', `${input.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} awaiting review`, `${u.username}: ₹${formatMoney(input.amountMinor)} (${u.mode.toLowerCase()})`);
      }
      return p;
    });
  }

  /** Withdrawable = cash − margin in use − other pending withdrawals. */
  private async available(tx: Parameters<Parameters<DbService['db']['transaction']>[0]>[0], userId: string, cashAccountId: string, excludePaymentId?: string) {
    const bal = await this.ledger.balance(tx, cashAccountId);
    const bps = await this.config.get('trading.intradayMarginBps');
    const margin = await this.orders.marginUsed(tx, userId, bps);
    const [pend] = await tx
      .select({ s: sql<string>`COALESCE(SUM(${paymentRequests.amountMinor}),0)::text` })
      .from(paymentRequests)
      .where(
        and(
          eq(paymentRequests.userId, userId),
          eq(paymentRequests.type, 'WITHDRAWAL'),
          eq(paymentRequests.status, 'REQUESTED'),
          excludePaymentId ? sql`${paymentRequests.id} <> ${excludePaymentId}` : undefined,
        ),
      );
    return bal - margin - BigInt(pend.s);
  }

  /** Checker: a Super Admin who is neither the requester nor the account owner. Posts atomically. */
  async approve(actor: Actor, id: string, note: string | undefined, ip: string) {
    return this.dbs.serializable(async (tx) => {
      const [p] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).for('update');
      if (!p) throw notFound('Payment request');
      if (p.status === 'POSTED') return p; // idempotent re-approval
      if (p.status !== 'REQUESTED') throw conflict(`Request is ${p.status.toLowerCase()}.`);
      if (p.requestedById === actor.userId || p.userId === actor.userId) {
        await this.audit.recordStandalone({ actor, action: 'payment.self_approval_blocked', entityType: 'payment', entityId: p.id, outcome: 'DENIED', ip });
        throw forbidden('Maker-checker: you cannot approve a request you created or that is for your own account.');
      }
      const cash = await this.ledger.cashAccount(tx, p.userId, p.mode);
      const fund = await this.ledger.systemAccount(tx, 'FUNDING_SOURCE', p.mode);
      await this.ledger.lock(tx, cash);
      if (p.type === 'WITHDRAWAL') {
        const avail = (await this.available(tx, p.userId, cash, p.id));
        if (p.amountMinor > avail) {
          const [f] = await tx.update(paymentRequests).set({ status: 'FAILED', reviewedById: actor.userId, reviewedIp: ip, reviewedAt: new Date(), reviewNote: 'Insufficient withdrawable balance at approval time', updatedAt: new Date() }).where(eq(paymentRequests.id, p.id)).returning();
          await this.audit.record(tx, { actor, action: 'payment.failed', entityType: 'payment', entityId: p.id, outcome: 'FAILURE', ip, metadata: { reason: 'insufficient_funds' } });
          await this.notifications.notify(tx, p.userId, 'payment.failed', 'Withdrawal could not be processed', 'Your withdrawable balance was lower than the requested amount.');
          return f;
        }
      }
      const sign = p.type === 'DEPOSIT' ? 1n : -1n;
      const j = await this.ledger.post(tx, {
        idempotencyKey: `payment:${p.id}`,
        kind: p.type,
        mode: p.mode,
        memo: `${p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}${p.mode === 'SIMULATED' ? ' (virtual funds — no cash value)' : ''}`,
        postings: [
          { accountId: cash, amountMinor: sign * p.amountMinor },
          { accountId: fund, amountMinor: -sign * p.amountMinor },
        ],
        createdById: actor.userId,
        refType: 'payment',
        refId: p.id,
      });
      const [done] = await tx
        .update(paymentRequests)
        .set({ status: 'POSTED', reviewedById: actor.userId, reviewedIp: ip, reviewedAt: new Date(), reviewNote: note?.slice(0, 500) ?? p.reviewNote, journalId: j.id, updatedAt: new Date() })
        .where(eq(paymentRequests.id, p.id))
        .returning();
      await this.audit.record(tx, { actor, action: 'payment.approved', entityType: 'payment', entityId: p.id, outcome: 'SUCCESS', ip, metadata: { journalId: j.id, amount: p.amountMinor, type: p.type, requestedBy: p.requestedById } });
      await this.notifications.notify(tx, p.userId, 'payment.posted', `${p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} approved`, `₹${formatMoney(p.amountMinor)} has been ${p.type === 'DEPOSIT' ? 'credited' : 'debited'}${p.mode === 'SIMULATED' ? ' (virtual)' : ''}.`);
      return done;
    });
  }

  async reject(actor: Actor, id: string, note: string, ip: string) {
    if (!note || note.trim().length < 3) throw badInput('Give a reason for rejecting.');
    return this.dbs.serializable(async (tx) => {
      const [p] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).for('update');
      if (!p) throw notFound('Payment request');
      if (p.status !== 'REQUESTED') throw conflict(`Request is ${p.status.toLowerCase()}.`);
      const [r] = await tx.update(paymentRequests).set({ status: 'REJECTED', reviewedById: actor.userId, reviewedIp: ip, reviewedAt: new Date(), reviewNote: note.slice(0, 500), updatedAt: new Date() }).where(eq(paymentRequests.id, id)).returning();
      await this.audit.record(tx, { actor, action: 'payment.rejected', entityType: 'payment', entityId: id, outcome: 'SUCCESS', ip, metadata: { note } });
      await this.notifications.notify(tx, p.userId, 'payment.rejected', 'Payment request rejected', note.slice(0, 200));
      return r;
    });
  }

  async cancel(actor: Actor, id: string, ip: string) {
    return this.dbs.serializable(async (tx) => {
      const [p] = await tx.select().from(paymentRequests).where(eq(paymentRequests.id, id)).for('update');
      if (!p || (p.userId !== actor.userId && p.requestedById !== actor.userId)) throw notFound('Payment request');
      if (p.status !== 'REQUESTED') throw conflict(`Request is ${p.status.toLowerCase()}.`);
      const [r] = await tx.update(paymentRequests).set({ status: 'CANCELLED', updatedAt: new Date() }).where(eq(paymentRequests.id, id)).returning();
      await this.audit.record(tx, { actor, action: 'payment.cancelled', entityType: 'payment', entityId: id, outcome: 'SUCCESS', ip });
      return r;
    });
  }

  /** Scoped listing: admin → all, broker → own traders, trader → self. */
  async list(actor: Actor, opts: { status?: PaymentStatus[]; userId?: string; limit: number }) {
    const where: (SQL | undefined)[] = [];
    if (opts.userId) {
      await this.policy.assertCanAccessUser(actor, opts.userId);
      where.push(eq(paymentRequests.userId, opts.userId));
    } else if (actor.role === 'TRADER') where.push(eq(paymentRequests.userId, actor.userId));
    else if (actor.role === 'BROKER') {
      where.push(inArray(paymentRequests.userId, this.dbs.db.select({ id: users.id }).from(users).where(eq(users.brokerId, actor.userId))));
    }
    if (opts.status?.length) where.push(inArray(paymentRequests.status, opts.status));
    return this.dbs.db.select().from(paymentRequests).where(and(...where)).orderBy(desc(paymentRequests.createdAt)).limit(opts.limit);
  }
}
