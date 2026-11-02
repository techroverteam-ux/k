import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Actor } from '../common/context';
import { AppError, badInput, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db';
import { feePayments, payeeAccounts, users } from '../db/schema';
import { NotificationsService } from '../notifications/notifications.service';

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^\d{9,18}$/;
export const UPI_RE = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
export const UTR_RE = /^[A-Za-z0-9]{6,30}$/;
const MAX_FEE_MINOR = 10_000_000n * 100n; // ₹1 crore

export interface PayeeInput { kind: 'BANK' | 'UPI'; label: string; accountName: string; bankName?: string; accountNumber?: string; ifsc?: string; branch?: string; upiId?: string }

/**
 * Course / subscription fees, paid in real money to the company's bank or UPI. Completely separate from the
 * virtual trading ledger: a verified fee never changes anyone's trading balance.
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly dbs: DbService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Traders and brokers see ACTIVE accounts only; Super Admin sees all. */
  listPayees(actor: Actor) {
    return this.dbs.db.select().from(payeeAccounts)
      .where(actor.role === 'SUPER_ADMIN' ? undefined : eq(payeeAccounts.status, 'ACTIVE'))
      .orderBy(asc(payeeAccounts.sortOrder), desc(payeeAccounts.createdAt));
  }

  async addPayee(actor: Actor, i: PayeeInput, ip: string) {
    const clean = (v?: string) => (v ?? '').trim();
    const label = clean(i.label), accountName = clean(i.accountName);
    if (label.length < 2 || label.length > 80) throw badInput('Give it a short name, like “HDFC current account”.');
    if (accountName.length < 2 || accountName.length > 120) throw badInput('Enter the account holder’s name exactly as the bank has it.');
    const row: typeof payeeAccounts.$inferInsert = { kind: i.kind, label, accountName, createdById: actor.userId };
    if (i.kind === 'BANK') {
      const accountNumber = clean(i.accountNumber).replace(/\s/g, ''), ifsc = clean(i.ifsc).toUpperCase();
      if (!ACCOUNT_RE.test(accountNumber)) throw badInput('Account number: 9–18 digits.');
      if (!IFSC_RE.test(ifsc)) throw badInput('IFSC: 11 characters, like HDFC0001234.');
      Object.assign(row, { accountNumber, ifsc, bankName: clean(i.bankName).slice(0, 120) || null, branch: clean(i.branch).slice(0, 120) || null });
    } else if (i.kind === 'UPI') {
      const upiId = clean(i.upiId).toLowerCase();
      if (!UPI_RE.test(upiId)) throw badInput('UPI ID looks like name@bank.');
      row.upiId = upiId;
    } else throw badInput('Choose bank account or UPI.');
    return this.dbs.db.transaction(async (tx) => {
      const [p] = await tx.insert(payeeAccounts).values(row).returning();
      await this.audit.record(tx, { actor, action: 'fees.payee_added', entityType: 'payee_account', entityId: p.id, outcome: 'SUCCESS', ip, metadata: { kind: p.kind, label: p.label, accountTail: p.accountNumber?.slice(-4), ifsc: p.ifsc, upiId: p.upiId } });
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
      for (const a of admins) if (a.id !== actor.userId) await this.notifications.notify(tx, a.id, 'fees.payee_pending', 'Approve new payment details', `“${p.label}” was added and needs another Super Admin to check and approve it before traders see it.`);
      return p;
    });
  }

  /** approve: a different Super Admin, PENDING → ACTIVE. reject: PENDING → REJECTED. disable: ACTIVE → DISABLED (any Super Admin, immediate). */
  async decidePayee(actor: Actor, id: string, action: 'approve' | 'reject' | 'disable', ip: string) {
    return this.dbs.db.transaction(async (tx) => {
      const [p] = await tx.select().from(payeeAccounts).where(eq(payeeAccounts.id, id)).for('update');
      if (!p) throw notFound('Payment details');
      if (action === 'disable') {
        if (p.status !== 'ACTIVE' && p.status !== 'PENDING') throw new AppError('CONFLICT', 'Already inactive.');
      } else {
        if (p.status !== 'PENDING') throw new AppError('CONFLICT', 'This was already decided.');
        if (action === 'approve' && p.createdById === actor.userId) throw new AppError('FORBIDDEN', 'A different Super Admin has to approve details you added.');
      }
      const status = action === 'approve' ? 'ACTIVE' : action === 'reject' ? 'REJECTED' : 'DISABLED';
      const [u] = await tx.update(payeeAccounts).set({ status, decidedById: actor.userId, decidedAt: new Date(), updatedAt: new Date() }).where(eq(payeeAccounts.id, id)).returning();
      await this.audit.record(tx, { actor, action: action === 'approve' ? 'fees.payee_approved' : action === 'reject' ? 'fees.payee_rejected' : 'fees.payee_disabled', entityType: 'payee_account', entityId: id, outcome: 'SUCCESS', ip, metadata: { label: p.label, from: p.status, to: status } });
      return u;
    });
  }

  async submit(actor: Actor, i: { payeeAccountId: string; amountMinor: bigint; purpose: string; utr: string }, ip: string) {
    const purpose = i.purpose.trim();
    const utr = i.utr.trim().toUpperCase();
    if (i.amountMinor <= 0n || i.amountMinor > MAX_FEE_MINOR) throw badInput('Enter the amount you paid.');
    if (purpose.length < 2 || purpose.length > 120) throw badInput('Say what the fee is for, like “Course fee, November batch”.');
    if (!UTR_RE.test(utr)) throw badInput('Enter the UTR / reference number from your bank or UPI app (6–30 letters and digits).');
    const [payee] = await this.dbs.db.select().from(payeeAccounts).where(and(eq(payeeAccounts.id, i.payeeAccountId), eq(payeeAccounts.status, 'ACTIVE')));
    if (!payee) throw notFound('Payment details');
    const [dup] = await this.dbs.db.select({ id: feePayments.id, userId: feePayments.userId }).from(feePayments).where(eq(feePayments.utr, utr));
    if (dup) throw new AppError('CONFLICT', dup.userId === actor.userId ? 'You already submitted this reference number.' : 'This reference number was already used.');
    return this.dbs.db.transaction(async (tx) => {
      const [f] = await tx.insert(feePayments).values({ userId: actor.userId, payeeAccountId: payee.id, amountMinor: i.amountMinor, purpose, utr, ip }).returning();
      await this.audit.record(tx, { actor, action: 'fees.payment_submitted', entityType: 'fee_payment', entityId: f.id, outcome: 'SUCCESS', ip, metadata: { amountMinor: i.amountMinor.toString(), payee: payee.label, utr } });
      return f;
    });
  }

  /** Trader: own. Broker: their traders. Super Admin: all. */
  list(actor: Actor, status?: string[], limit = 100) {
    const where: (SQL | undefined)[] = [];
    if (actor.role === 'TRADER') where.push(eq(feePayments.userId, actor.userId));
    else if (actor.role === 'BROKER') where.push(inArray(feePayments.userId, this.dbs.db.select({ id: users.id }).from(users).where(eq(users.brokerId, actor.userId))));
    if (status?.length) where.push(inArray(feePayments.status, status));
    return this.dbs.db
      .select({ f: feePayments, username: users.username, displayName: users.displayName, payee: payeeAccounts.label })
      .from(feePayments)
      .innerJoin(users, eq(users.id, feePayments.userId))
      .innerJoin(payeeAccounts, eq(payeeAccounts.id, feePayments.payeeAccountId))
      .where(and(...where))
      .orderBy(desc(feePayments.createdAt))
      .limit(limit);
  }

  async review(actor: Actor, id: string, verified: boolean, note: string | undefined, ip: string) {
    if (!verified && (!note || note.trim().length < 3)) throw badInput('Say why it was rejected (the trader sees this).');
    return this.dbs.db.transaction(async (tx) => {
      const [f] = await tx.select().from(feePayments).where(eq(feePayments.id, id)).for('update');
      if (!f) throw notFound('Fee payment');
      if (f.status !== 'SUBMITTED') throw new AppError('CONFLICT', 'This payment was already reviewed.');
      const [u] = await tx.update(feePayments).set({ status: verified ? 'VERIFIED' : 'REJECTED', reviewNote: note?.trim().slice(0, 300) || null, reviewedById: actor.userId, reviewedAt: new Date() }).where(eq(feePayments.id, id)).returning();
      await this.audit.record(tx, { actor, action: verified ? 'fees.payment_verified' : 'fees.payment_rejected', entityType: 'fee_payment', entityId: id, outcome: 'SUCCESS', ip, metadata: { utr: f.utr, amountMinor: f.amountMinor.toString(), note } });
      await this.notifications.notify(tx, f.userId, verified ? 'fees.verified' : 'fees.rejected', verified ? 'Fee payment confirmed' : 'Fee payment not confirmed',
        verified ? `We received your payment (reference ${f.utr}). Thank you!` : `We couldn’t confirm your payment with reference ${f.utr}: ${note}`);
      return u;
    });
  }
}
