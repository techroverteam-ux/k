import 'reflect-metadata';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../src/db/db';
import { AuditService } from '../src/audit/audit.service';
import { ConfigService } from '../src/config-mgmt/config.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { PasswordService } from '../src/auth/password.service';
import { AuthService } from '../src/auth/auth.service';
import { WipeService } from '../src/wipe/wipe.service';
import { UsersService } from '../src/users/users.service';
import { PolicyService } from '../src/policy/policy.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { afterWipeFor } from '../src/wipe/visibility';
import { accountResetRequests, accountWipes, feePayments, feePaymentProofs, instruments, ledgerPostings, notifications, orders, payeeAccounts, platformWipes, positions, sessions, users, watchlistItems } from '../src/db/schema';
import type { Actor } from '../src/common/context';

// This suite may only run against a newly-created, explicitly isolated local database.
const run = process.env.RUN_RESET_INTEGRATION === 'true';
const suite = run ? describe : describe.skip;
jest.setTimeout(120_000);
suite('isolated PostgreSQL reset approvals and lockout', () => {
  let db: DbService, audit: AuditService, ledger: LedgerService, auth: AuthService, wipe: WipeService, usersSvc: UsersService;
  let admin: Actor, checker: Actor, broker: Actor, otherBroker: Actor, trader: Actor, instrumentId: string, orderId: string, cash: string;
  const pw = 'Integration-Strong-Pass-71'; const meta = { ip: '127.0.0.1', userAgent: 'isolated-test' };
  const actor = (u: { id: string; role: any }): Actor => ({ userId: u.id, role: u.role, sessionId: 'test', mfaVerified: true });
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/^\/tradedesk_reset_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Refusing a non-isolated database.');
    db = new DbService(); audit = new AuditService(db); ledger = new LedgerService(db);
    const passwords = new PasswordService(), config = new ConfigService(db, audit), alerts = new NotificationsService(db), policy = new PolicyService(db, audit);
    auth = new AuthService(db, passwords, audit, config, ledger, alerts, {} as any);
    wipe = new WipeService(db, auth, ledger, audit, alerts, { clearAll: jest.fn() } as any, config);
    usersSvc = new UsersService(db, audit, passwords, policy, ledger, {} as any, {} as any, config, alerts);
    const hash = await passwords.hash(pw);
    const add = async (username: string, role: 'SUPER_ADMIN' | 'BROKER' | 'TRADER', brokerId?: string) => (await db.db.insert(users).values({ username, displayName: username, role, status: 'ACTIVE', passwordHash: hash, brokerId }).returning())[0];
    admin = actor(await add('admin.reset', 'SUPER_ADMIN')); checker = admin;
    broker = actor(await add('broker.reset', 'BROKER')); otherBroker = actor(await add('broker.other', 'BROKER')); trader = actor(await add('trader.reset', 'TRADER', broker.userId));
    instrumentId = (await db.db.insert(instruments).values({ symbol: 'RESETTEST', name: 'Reset test', exchange: 'NSE', segment: 'FUT', lotSize: 1, tickMinor: 1, refPriceMinor: 100000n }).returning())[0].id;
    orderId = (await db.db.insert(orders).values({ userId: trader.userId, instrumentId, side: 'BUY', type: 'MARKET', quantity: 1, status: 'FILLED', venue: 'SIMULATED', mode: 'SIMULATED', placedById: trader.userId, idempotencyKey: 'reset-test-order' }).returning())[0].id;
    await db.db.insert(positions).values({ userId: trader.userId, instrumentId, mode: 'SIMULATED', netQty: 0, realizedPnlMinor: 100n });
    await db.db.insert(watchlistItems).values({ userId: trader.userId, instrumentId, listIndex: 0 });
    cash = await ledger.cashAccount(db.db, trader.userId, 'SIMULATED');
    await db.serializable(async (tx) => {
      const funding = await ledger.systemAccount(tx, 'FUNDING_SOURCE', 'SIMULATED');
      await ledger.post(tx, { idempotencyKey: 'test-opening', kind: 'OPENING_BALANCE', mode: 'SIMULATED', memo: 'Opening', postings: [{ accountId: cash, amountMinor: 100000n }, { accountId: funding, amountMinor: -100000n }] });
      const fees = await ledger.systemAccount(tx, 'FEE_INCOME', 'SIMULATED');
      await ledger.post(tx, { idempotencyKey: 'test-fee', kind: 'FEE', mode: 'SIMULATED', memo: 'Fee', refType: 'order', refId: orderId, postings: [{ accountId: cash, amountMinor: -100n }, { accountId: fees, amountMinor: 100n }] });
    });
  });
  afterAll(async () => { await db?.onApplicationShutdown(); });
  it.each(['broker.reset', 'trader.reset'])('locks %s after exactly five failures and resets after a one-hour cooldown', async (username) => {
    for (let n = 1; n <= 5; n++) {
      const error = await auth.login(username, 'wrong', meta).catch((e) => e);
      expect(error.extensions.remainingAttempts).toBe(5 - n);
      expect(error.extensions.code).toBe(n === 5 ? 'LOGIN_LOCKED' : 'UNAUTHENTICATED');
      if (n === 5) expect(error.extensions.retryAfterSec).toBeGreaterThan(3590);
    }
    await expect(auth.login(username, pw, meta)).rejects.toMatchObject({ extensions: { code: 'LOGIN_LOCKED' } });
    await db.db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.username, username));
    expect((await auth.login(username, pw, meta)).mfaRequired).toBe(false);
    expect((await db.db.select().from(users).where(eq(users.username, username)))[0].failedLoginCount).toBe(0);
  });
  it('counts concurrent failures without lost updates', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => auth.login('broker.other', 'wrong', meta).catch((e) => e)));
    expect(results.map((e) => e.extensions.remainingAttempts).sort()).toEqual([0, 1, 2, 3, 4]);
    expect((await db.db.select().from(users).where(eq(users.id, otherBroker.userId)))[0].failedLoginCount).toBe(5);
  });
  it('gives unknown usernames the same five-attempt response without exposing account existence', async () => {
    for (let n = 1; n <= 5; n++) expect((await auth.login('unknown.reset', 'wrong', meta).catch((e) => e)).extensions.remainingAttempts).toBe(5 - n);
    await expect(auth.login('unknown.reset', pw, meta)).rejects.toMatchObject({ extensions: { code: 'LOGIN_LOCKED' } });
  });
  it('requests notify both admins and the assigned broker, and cannot be self-approved or approved by another broker', async () => {
    const r = await wipe.requestAccountReset(trader, 'Start a fresh trader account', 'WIPE', meta.ip);
    expect((await db.db.select().from(notifications).where(eq(notifications.kind, 'account.reset_requested'))).map((n) => n.userId).sort()).toEqual([admin.userId, broker.userId].sort());
    await expect(wipe.requestAccountReset(trader, 'Another reset request', 'WIPE', meta.ip)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    await expect(wipe.decideAccountReset(trader, r.id, true, meta.ip)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(wipe.decideAccountReset(otherBroker, r.id, true, meta.ip)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await db.db.update(positions).set({ netQty: 1 }).where(eq(positions.userId, trader.userId));
    await expect(wipe.decideAccountReset(broker, r.id, true, meta.ip)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    await db.db.update(positions).set({ netQty: 0 }).where(eq(positions.userId, trader.userId));
    const before = await db.db.$count(ledgerPostings);
    expect((await wipe.decideAccountReset(broker, r.id, true, meta.ip)).status).toBe('APPROVED');
    const [u] = await db.db.select().from(users).where(eq(users.id, trader.userId));
    expect(u.status).toBe('SUSPENDED'); expect(u.resetDisabledAt).not.toBeNull();
    expect(await ledger.balance(db.db, cash)).toBe(0n);
    expect(await db.db.$count(ledgerPostings)).toBe(before + 2);
    expect(await db.db.$count(orders, eq(orders.id, orderId))).toBe(1);
    expect((await db.db.select().from(watchlistItems).where(eq(watchlistItems.userId, trader.userId)))[0].archivedAt).not.toBeNull();
    expect(await db.db.$count(accountWipes, eq(accountWipes.userId, trader.userId))).toBe(1);
    expect((await db.db.select().from(sessions).where(eq(sessions.userId, trader.userId))).every((s) => s.revokedAt)).toBe(true);
    await expect(wipe.decideAccountReset(admin, r.id, true, meta.ip)).rejects.toThrow();
    expect(await db.db.$count(accountWipes, eq(accountWipes.userId, trader.userId))).toBe(1);
    for (const viewer of [admin, checker, broker]) expect(await db.db.select().from(orders).where(and(eq(orders.id, orderId), afterWipeFor(viewer, orders.createdAt, trader.userId)))).toHaveLength(1);
    expect(await db.db.select().from(orders).where(and(eq(orders.id, orderId), afterWipeFor(trader, orders.createdAt, trader.userId)))).toHaveLength(0);
    expect((await usersSvc.brokerCommission(broker, broker.userId, new Date('2020-01-01'), new Date('2100-01-01'))).lines).toHaveLength(1);
    const notified = await db.db.select().from(notifications).where(eq(notifications.kind, 'account.reset_decided'));
    expect(new Set(notified.map((n) => n.userId))).toEqual(new Set([trader.userId, broker.userId, admin.userId, checker.userId]));
  });
  it('only staff or the assigned broker can re-enable the reset trader, keeping a fresh zero balance', async () => {
    await expect(usersSvc.setStatus(otherBroker, trader.userId, 'ACTIVE', 'Re-enable trader', meta.ip)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const user = await usersSvc.setStatus(broker, trader.userId, 'ACTIVE', 'Re-enable trader', meta.ip);
    expect(user.status).toBe('ACTIVE'); expect(user.resetDisabledAt).toBeNull(); expect(await ledger.balance(db.db, cash)).toBe(0n);
  });
  it('broker resets affect only their own visibility; traders and admin commission history remain unchanged', async () => {
    const before = await db.db.select().from(users).where(eq(users.id, trader.userId));
    const request = await wipe.requestAccountReset(broker, 'Clear my previous broker view', 'WIPE', meta.ip);
    await expect(wipe.decideAccountReset(broker, request.id, true, meta.ip)).rejects.toThrow();
    await wipe.decideAccountReset(checker, request.id, true, meta.ip);
    expect(await db.db.select().from(users).where(eq(users.id, trader.userId))).toEqual(before);
    expect((await usersSvc.brokerCommission(broker, broker.userId, new Date('2020-01-01'), new Date('2100-01-01'))).lines).toHaveLength(0);
    expect((await usersSvc.brokerCommission(admin, broker.userId, new Date('2020-01-01'), new Date('2100-01-01'))).lines).toHaveLength(1);
  });
  it('expired soft requests commit EXPIRED without resetting the user', async () => {
    const r = await wipe.requestAccountReset(broker, 'Another broker reset request', 'WIPE', meta.ip);
    await db.db.update(accountResetRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accountResetRequests.id, r.id));
    await expect(wipe.decideAccountReset(admin, r.id, true, meta.ip)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect((await db.db.select().from(accountResetRequests).where(eq(accountResetRequests.id, r.id)))[0].status).toBe('EXPIRED');
  });
  it('simultaneous soft-reset approvals execute only once', async () => {
    const request = await wipe.requestAccountReset(broker, 'Clear my broker view again', 'WIPE', meta.ip);
    const results = await Promise.allSettled([wipe.decideAccountReset(admin, request.id, true, meta.ip), wipe.decideAccountReset(checker, request.id, true, meta.ip)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('rejects provisioning a second active Super Admin at database level', async () => {
    await expect(db.db.insert(users).values({ username: 'second.admin', displayName: 'Second', role: 'SUPER_ADMIN', status: 'ACTIVE', passwordHash: 'unused' })).rejects.toThrow();
  });
  it('platform wipe requires a different admin, expires at 30 minutes, and hard-deletes fee proofs and all broker/trader records', async () => {
    const expired = await wipe.requestPlatform(admin, 'End of isolated training batch', 'WIPE ALL DATA', meta.ip);
    expect(expired.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    await db.db.update(platformWipes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(platformWipes.id, expired.id));
    await expect(wipe.approvePlatform(checker, expired.id, 'WIPE ALL DATA', meta.ip)).rejects.toMatchObject({ extensions: { code: 'CONFLICT' } });
    expect((await db.db.select().from(platformWipes).where(eq(platformWipes.id, expired.id)))[0].status).toBe('EXPIRED');
    const payee = (await db.db.insert(payeeAccounts).values({ kind: 'UPI', label: 'Test', accountName: 'Test', createdById: admin.userId }).returning())[0];
    const fee = (await db.db.insert(feePayments).values({ userId: trader.userId, payeeAccountId: payee.id, amountMinor: 100n, purpose: 'Test', utr: 'Test', utrHash: '0'.repeat(64) }).returning())[0];
    await db.db.insert(feePaymentProofs).values({ feePaymentId: fee.id, mime: 'image/png', data: 'test', bytes: 100 });
    const r = await wipe.requestPlatform(admin, 'End of isolated training batch', 'WIPE ALL DATA', meta.ip);
    expect((await wipe.approvePlatform(checker, r.id, 'WIPE ALL DATA', meta.ip)).accounts).toBe(3);
    expect((await db.db.select().from(users)).map((u) => u.role)).toEqual(['SUPER_ADMIN']);
    for (const table of [orders, positions, ledgerPostings, accountWipes, accountResetRequests, feePayments, feePaymentProofs]) expect(await db.db.$count(table)).toBe(0);
    expect(await db.db.$count(notifications, eq(notifications.kind, 'platform.wipe_completed'))).toBe(1);
  });
});
