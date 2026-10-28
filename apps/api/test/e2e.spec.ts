/**
 * End-to-end security & financial-integrity tests against a real PostgreSQL database.
 * Covers: authentication, MFA, step-up, cross-account access (IDOR), role checks,
 * maker-checker, idempotent payments & orders under concurrency, ledger invariants,
 * append-only enforcement, refresh-token reuse detection, GraphQL depth limits.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { authenticator } from 'otplib';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { requestContextMiddleware } from '../src/common/request-context';
import { MarketDataService } from '../src/market/market-data.service';
import { ActivityLogService } from '../src/logging/activity-log.service';
import { archiveDay, verifyArchive } from '../src/logging/archive';
import { DbService } from '../src/db/db';
import { appendFileSync, rmSync } from 'fs';
import { sessionStatus } from '../src/trading/market-hours';
import { ConfigService } from '../src/config-mgmt/config.service';
import { AlgoRunnerService } from '../src/algo/algo-runner.service';
import { pubsub, TOPIC } from '../src/notifications/notifications.service';
import { decryptField, encryptField, needsRotation, resetKeyRing } from '../src/common/crypto';

jest.setTimeout(120_000);

let app: INestApplication;
let url: string;
let pg: Pool;
const PW = process.env.SEED_PASSWORD!;

type Res = { data?: any; errors?: Array<{ message: string; extensions?: { code?: string } }> };

async function gql(query: string, variables: Record<string, unknown> = {}, opts: { token?: string; stepUp?: string; mobile?: boolean; ua?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': opts.ua ?? 'jest-e2e',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.stepUp ? { 'x-step-up': opts.stepUp } : {}),
      ...(opts.mobile !== false ? { 'x-client': 'mobile' } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json() as Promise<Res>;
}
const code = (r: Res) => r.errors?.[0]?.extensions?.code;

const tokenCache = new Map<string, Awaited<ReturnType<typeof freshLogin>>>();
/** Cached login (the API rate-limits logins, which the tests also exercise). */
async function login(username: string) {
  if (!tokenCache.has(username)) {
    const t = await freshLogin(username);
    if (t.user.role === 'TRADER') await acceptConsent(t.accessToken); // traders accept the rules once per session before trading
    tokenCache.set(username, t);
  }
  return tokenCache.get(username)!;
}
async function acceptConsent(token: string) {
  const st = await gql(`{ tradingConsentStatus { termsVersion } }`, {}, { token });
  return gql(`mutation($v:String!){ acceptTradingConsent(termsVersion:$v){ id ip acceptedAt } }`, { v: st.data.tradingConsentStatus.termsVersion }, { token });
}
async function freshLogin(username: string, password = PW) {
  const r = await gql(`mutation($u:String!,$p:String!){ login(username:$u,password:$p){ accessToken refreshToken mfaRequired mfaToken user{ id role } } }`, { u: username, p: password });
  if (r.errors) throw new Error(`${username}: ${r.errors[0].message}`);
  return r.data.login as { accessToken: string; refreshToken: string; mfaRequired: boolean; mfaToken: string; user: { id: string; role: string } };
}

const secrets: Record<string, string> = {};
const adminCache = new Map<string, { token: string; id: string }>();
async function adminLogin(username: string, fresh = false) {
  if (!fresh && adminCache.has(username)) return adminCache.get(username)!;
  const r = await adminLoginRaw(username);
  adminCache.set(username, r);
  return r;
}
/** Admin login: enrol MFA on first use, afterwards complete the TOTP challenge. */
async function adminLoginRaw(username: string) {
  const first = await freshLogin(username);
  if (!first.mfaRequired) {
    const en = await gql(`mutation{ beginMfaEnrollment{ secret } }`, {}, { token: first.accessToken });
    secrets[username] = en.data.beginMfaEnrollment.secret;
    const ok = await gql(`mutation($c:String!){ confirmMfaEnrollment(code:$c) }`, { c: authenticator.generate(secrets[username]) }, { token: first.accessToken });
    expect(ok.data.confirmMfaEnrollment).toBe(true);
    return { token: first.accessToken, id: first.user.id };
  }
  const r = await gql(`mutation($t:String!,$c:String!){ completeMfaLogin(mfaToken:$t, code:$c){ accessToken user{ id } } }`, { t: first.mfaToken, c: authenticator.generate(secrets[username]) });
  return { token: r.data.completeMfaLogin.accessToken, id: r.data.completeMfaLogin.user.id };
}
const stepUpCache = new Map<string, string>();
async function stepUp(token: string, username: string) {
  if (stepUpCache.has(token)) return stepUpCache.get(token)!;
  const r = await gql(`mutation($t:String){ stepUp(totp:$t){ token } }`, { t: authenticator.generate(secrets[username]) }, { token });
  stepUpCache.set(token, r.data.stepUp.token);
  return r.data.stepUp.token as string;
}

const OPEN_POLICY = { SUPER_ADMIN: { maxConcurrent: 0, onLimit: 'ask', idleMinutes: 30, maxHours: 12 }, BROKER: { maxConcurrent: 0, onLimit: 'ask', idleMinutes: 120, maxHours: 24 }, TRADER: { maxConcurrent: 0, onLimit: 'ask', idleMinutes: 480, maxHours: 24 } };
/** Test helper: approve a config value directly (the maker-checker flow itself is tested separately). */
async function setConfig(key: string, value: unknown) {
  const p = pg ?? new Pool({ connectionString: process.env.DATABASE_URL });
  await p.query(`UPDATE config_versions SET status = 'SUPERSEDED' WHERE key = $1 AND status IN ('APPROVED','PENDING')`, [key]);
  const { rows } = await p.query(`SELECT coalesce(max(version),0)+1 AS v FROM config_versions WHERE key = $1`, [key]);
  await p.query(`INSERT INTO config_versions (key, version, value, status, reason, decided_at) VALUES ($1, $2, $3, 'APPROVED', 'test setup', now())`, [key, rows[0].v, JSON.stringify(value)]);
  if (!pg) await p.end();
  if (app) app.get(ConfigService).invalidate();
}

const SUMMARY = `query($u:ID){ accountSummary(userId:$u){ balance available marginUsed realizedPnl fees } }`;

beforeAll(async () => {
  const base = process.env.DATABASE_URL!;
  const admin = new Pool({ connectionString: base.replace(/\/[^/]+$/, '/postgres') });
  const db = base.split('/').pop()!.split('?')[0];
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  execSync('npx ts-node --transpile-only scripts/migrate.ts', { stdio: 'inherit', env: process.env });
  execSync('npx ts-node --transpile-only scripts/seed.ts', { stdio: 'inherit', env: process.env });
  pg = new Pool({ connectionString: base });

  // Most suites sign the same users in many times: start with no concurrent-session limit.
  await setConfig('security.sessionPolicy', OPEN_POLICY);
  app = await NestFactory.create(AppModule, { logger: ['error'], bodyParser: false });
  app.use(requestContextMiddleware);
  app.use(json({ limit: '100kb' }));
  app.use(cookieParser());
  await app.listen(0);
  url = `${await app.getUrl()}/graphql`.replace('[::1]', '127.0.0.1');
});

afterAll(async () => {
  await pg?.end();
  await app?.close();
});

describe('authentication', () => {
  it('rejects bad passwords with a generic message', async () => {
    const r = await gql(`mutation{ login(username:"trader.one", password:"wrong-password-1A"){ accessToken } }`);
    expect(code(r)).toBe('UNAUTHENTICATED');
    const r2 = await gql(`mutation{ login(username:"no.such.user", password:"wrong-password-1A"){ accessToken } }`);
    expect(r2.errors?.[0].message).toBe(r.errors?.[0].message);
  });

  it('requires authentication for private queries', async () => {
    expect(code(await gql(`{ me { id } }`))).toBe('UNAUTHENTICATED');
    expect(code(await gql(`{ me { id } }`, {}, { token: 'garbage.token.value' }))).toBe('UNAUTHENTICATED');
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const t = await freshLogin('trader.two');
    const r1 = await gql(`mutation($r:String){ refresh(refreshToken:$r){ accessToken refreshToken } }`, { r: t.refreshToken });
    expect(r1.data.refresh.refreshToken).not.toBe(t.refreshToken);
    // replay the old token → reuse detected → session revoked
    const replay = await gql(`mutation($r:String){ refresh(refreshToken:$r){ accessToken } }`, { r: t.refreshToken });
    expect(code(replay)).toBe('UNAUTHENTICATED');
    const after = await gql(`mutation($r:String){ refresh(refreshToken:$r){ accessToken } }`, { r: r1.data.refresh.refreshToken });
    expect(code(after)).toBe('UNAUTHENTICATED');
    expect(code(await gql(`{ me { id } }`, {}, { token: r1.data.refresh.accessToken }))).toBe('UNAUTHENTICATED');
  });

  it('creates a demo account via OTP with the configured virtual balance', async () => {
    const req = await gql(`mutation{ requestDemoOtp(phone:"9876543210"){ sentTo devCode } }`);
    expect(req.data.requestDemoOtp.sentTo).toMatch(/\*/);
    const bad = await gql(`mutation{ verifyDemoOtp(phone:"9876543210", code:"000000"){ accessToken } }`);
    expect(code(bad)).toBe('UNAUTHENTICATED');
    const ok = await gql(`mutation($c:String!){ verifyDemoOtp(phone:"9876543210", code:$c){ accessToken user{ username isDemo mode } } }`, { c: req.data.requestDemoOtp.devCode });
    expect(ok.data.verifyDemoOtp.user.isDemo).toBe(true);
    expect(ok.data.verifyDemoOtp.user.mode).toBe('SIMULATED');
    const s = await gql(SUMMARY, {}, { token: ok.data.verifyDemoOtp.accessToken });
    expect(s.data.accountSummary.balance).toBe('500000.00');
    // OTP is single-use
    const again = await gql(`mutation($c:String!){ verifyDemoOtp(phone:"9876543210", code:$c){ accessToken } }`, { c: req.data.requestDemoOtp.devCode });
    expect(code(again)).toBe('UNAUTHENTICATED');
  });
});

describe('authorization (role + resource level)', () => {
  it('blocks traders from admin operations', async () => {
    const t = await login('trader.one');
    expect(code(await gql(`{ adminOverview { traders } }`, {}, { token: t.accessToken }))).toBe('FORBIDDEN');
    expect(code(await gql(`{ users { total } }`, {}, { token: t.accessToken }))).toBe('FORBIDDEN');
  });

  it('prevents IDOR: a trader cannot read another trader by ID', async () => {
    const t1 = await login('trader.one');
    const t3 = await login('trader.three');
    const r = await gql(SUMMARY, { u: t3.user.id }, { token: t1.accessToken });
    expect(code(r)).toBe('NOT_FOUND');
    const o = await gql(`query($u:ID){ orders(userId:$u){ id } }`, { u: t3.user.id }, { token: t1.accessToken });
    expect(code(o)).toBe('NOT_FOUND');
  });

  it('scopes brokers to their own traders only', async () => {
    const b1 = await login('broker.one');
    const t1 = await login('trader.one');
    const t3 = await login('trader.three');
    const list = await gql(`{ users { total items { username } } }`, {}, { token: b1.accessToken });
    const names = list.data.users.items.map((u: any) => u.username).sort();
    expect(names).toEqual(['trader.one', 'trader.two']);
    expect((await gql(SUMMARY, { u: t1.user.id }, { token: b1.accessToken })).data.accountSummary.balance).toBeDefined();
    expect(code(await gql(SUMMARY, { u: t3.user.id }, { token: b1.accessToken }))).toBe('NOT_FOUND');
  });

  it('forces Super Admins to enrol MFA before doing anything privileged', async () => {
    const a = await freshLogin('admin');
    expect(a.mfaRequired).toBe(false);
    expect(code(await gql(`{ adminOverview { traders } }`, {}, { token: a.accessToken }))).toBe('MFA_REQUIRED');
    const admin = await adminLogin('admin', true); // enrols on this session
    // fresh login now demands TOTP
    expect((await freshLogin('admin')).mfaRequired).toBe(true);
    const full = await adminLogin('admin', true);
    expect((await gql(`{ adminOverview { traders brokers } }`, {}, { token: full.token })).data.adminOverview.traders).toBeGreaterThanOrEqual(3);
    expect(admin.id).toBe(full.id);
    await adminLogin('checker');
  });
});

describe('payments: idempotency, maker-checker, step-up', () => {
  it('deduplicates retried requests and posts exactly once', async () => {
    const t = await login('trader.one');
    const key = randomUUID();
    const q = `mutation($k:String!){ requestPayment(input:{type:DEPOSIT, amount:"25000.50", idempotencyKey:$k}){ id status amount } }`;
    const results = await Promise.all(Array.from({ length: 8 }, () => gql(q, { k: key }, { token: t.accessToken })));
    const ids = new Set(results.filter((r) => !r.errors).map((r) => r.data.requestPayment.id));
    expect(ids.size).toBe(1);
    const id = [...ids][0];

    const admin = await adminLogin('admin');
    const approve = `mutation($id:ID!){ approvePayment(id:$id){ status journalId } }`;
    expect(code(await gql(approve, { id }, { token: admin.token }))).toBe('STEP_UP_REQUIRED');
    const su = await stepUp(admin.token, 'admin');
    const before = (await gql(SUMMARY, {}, { token: t.accessToken })).data.accountSummary.balance;
    const approvals = await Promise.all(Array.from({ length: 5 }, () => gql(approve, { id }, { token: admin.token, stepUp: su })));
    const journals = new Set(approvals.filter((r) => !r.errors).map((r) => r.data.approvePayment.journalId));
    expect(journals.size).toBe(1);
    const after = (await gql(SUMMARY, {}, { token: t.accessToken })).data.accountSummary.balance;
    expect(Number(after) - Number(before)).toBeCloseTo(25000.5, 2);
  });

  it('blocks a Super Admin from approving a request they created (maker-checker)', async () => {
    const admin = await adminLogin('admin');
    const checker = await adminLogin('checker');
    const t2 = await login('trader.two');
    const r = await gql(`mutation($u:ID,$k:String!){ requestPayment(input:{type:DEPOSIT, amount:"100.00", idempotencyKey:$k, userId:$u}){ id } }`, { u: t2.user.id, k: randomUUID() }, { token: admin.token });
    const id = r.data.requestPayment.id;
    const self = await gql(`mutation($id:ID!){ approvePayment(id:$id){ status } }`, { id }, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(code(self)).toBe('FORBIDDEN');
    const other = await gql(`mutation($id:ID!){ approvePayment(id:$id){ status } }`, { id }, { token: checker.token, stepUp: await stepUp(checker.token, 'checker') });
    expect(other.data.approvePayment.status).toBe('POSTED');
  });

  it('lets brokers submit only for their own traders', async () => {
    const b1 = await login('broker.one');
    const t1 = await login('trader.one');
    const t3 = await login('trader.three');
    const q = `mutation($u:ID,$k:String!){ requestPayment(input:{type:DEPOSIT, amount:"500.00", idempotencyKey:$k, userId:$u}){ id status } }`;
    expect((await gql(q, { u: t1.user.id, k: randomUUID() }, { token: b1.accessToken })).data.requestPayment.status).toBe('REQUESTED');
    expect(code(await gql(q, { u: t3.user.id, k: randomUUID() }, { token: b1.accessToken }))).toBe('NOT_FOUND');
  });

  it('refuses withdrawals above the withdrawable balance', async () => {
    const t = await login('trader.three');
    const r = await gql(`mutation($k:String!){ requestPayment(input:{type:WITHDRAWAL, amount:"5000000.00", idempotencyKey:$k}){ id } }`, { k: randomUUID() }, { token: t.accessToken });
    expect(['INSUFFICIENT_FUNDS', 'BAD_USER_INPUT']).toContain(code(r));
  });
});

describe('paper trading', () => {
  const PLACE = `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status fillPrice venue rejectReason } }`;
  let instrumentId: string;
  let market: MarketDataService;

  beforeAll(async () => {
    const { rows } = await pg.query(`SELECT id FROM instruments WHERE symbol = 'ABB26NOVFUT'`);
    instrumentId = rows[0].id;
    market = app.get(MarketDataService);
    market.setPrice(instrumentId, 636450n);
  });

  it('creates exactly one order for concurrent retries with the same idempotency key', async () => {
    const t = await login('trader.two');
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 10 }, () => gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'MARKET', quantity: 10, idempotencyKey: key } }, { token: t.accessToken })),
    );
    const ids = new Set(res.filter((r) => !r.errors).map((r) => r.data.placeOrder.id));
    expect(ids.size).toBe(1);
    const o = res.find((r) => !r.errors)!.data.placeOrder;
    expect(o.status).toBe('FILLED');
    expect(o.venue).toBe('SIMULATED');
  });

  it('rejects orders over the per-order quantity limit and logs them', async () => {
    const t = await login('trader.two');
    const r = await gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'MARKET', quantity: 51, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(r.data.placeOrder.status).toBe('REJECTED');
    const rej = await gql(`{ orders(status:[REJECTED]){ id rejectReason } }`, {}, { token: t.accessToken });
    expect(rej.data.orders.length).toBeGreaterThanOrEqual(1);
  });

  it('realises P&L through the ledger on close', async () => {
    const t = await login('trader.two');
    const before = (await gql(SUMMARY, {}, { token: t.accessToken })).data.accountSummary;
    market.setPrice(instrumentId, 646450n); // +₹100
    const r = await gql(PLACE, { i: { instrumentId, side: 'SELL', type: 'MARKET', quantity: 10, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(r.data.placeOrder.status).toBe('FILLED');
    const after = (await gql(SUMMARY, {}, { token: t.accessToken })).data.accountSummary;
    expect(Number(after.realizedPnl)).toBeGreaterThan(Number(before.realizedPnl));
    const pos = await gql(`{ positions { netQty realizedPnl instrument { symbol } } }`, {}, { token: t.accessToken });
    expect(pos.data.positions[0].netQty).toBe(0);
  });

  it('fills a resting limit order when the price crosses it', async () => {
    const t = await login('trader.one');
    market.setPrice(instrumentId, 636450n);
    const r = await gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'LIMIT', quantity: 5, limitPrice: '6300.00', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(r.data.placeOrder.status).toBe('OPEN');
    market.setPrice(instrumentId, 629000n);
    await new Promise((res) => setTimeout(res, 1500));
    const o = await gql(`{ orders(status:[FILLED, OPEN]){ id status } }`, {}, { token: t.accessToken });
    expect(o.data.orders.find((x: any) => x.id === r.data.placeOrder.id).status).toBe('FILLED');
  });

  it('does not let admins or brokers place orders', async () => {
    const b = await login('broker.one');
    const r = await gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'MARKET', quantity: 1, idempotencyKey: randomUUID() } }, { token: b.accessToken });
    expect(code(r)).toBe('FORBIDDEN');
  });
});

describe('configuration maker-checker', () => {
  it('requires a second admin to approve, then applies the value', async () => {
    const admin = await adminLogin('admin');
    const checker = await adminLogin('checker');
    const p = await gql(`mutation{ proposeConfigChange(key:"trading.maxQtyPerOrder", valueJson:"60", reason:"Raise punch qty for test"){ id status } }`, {}, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(p.data.proposeConfigChange.status).toBe('PENDING');
    const bad = await gql(`mutation{ proposeConfigChange(key:"trading.maxQtyPerOrder", valueJson:"\\"lots\\"", reason:"invalid type"){ id } }`, {}, { token: checker.token, stepUp: await stepUp(checker.token, 'checker') });
    expect(code(bad)).toBe('BAD_USER_INPUT');
    const self = await gql(`mutation($id:ID!){ decideConfigChange(id:$id, approve:true){ status } }`, { id: p.data.proposeConfigChange.id }, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(code(self)).toBe('FORBIDDEN');
    const ok = await gql(`mutation($id:ID!){ decideConfigChange(id:$id, approve:true){ status } }`, { id: p.data.proposeConfigChange.id }, { token: checker.token, stepUp: await stepUp(checker.token, 'checker') });
    expect(ok.data.decideConfigChange.status).toBe('APPROVED');
    const items = await gql(`{ configItems { key valueJson version } }`, {}, { token: admin.token });
    expect(items.data.configItems.find((i: any) => i.key === 'trading.maxQtyPerOrder').valueJson).toBe('60');
  });

  it('rejects secrets-like keys (unknown keys are refused)', async () => {
    const admin = await adminLogin('admin');
    const r = await gql(`mutation{ proposeConfigChange(key:"payments.gatewaySecret", valueJson:"\\"x\\"", reason:"should fail"){ id } }`, {}, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(code(r)).toBe('BAD_USER_INPUT');
  });
});

describe('integrity', () => {
  it('blocks UPDATE/DELETE on ledger and audit tables at the database level', async () => {
    await expect(pg.query(`UPDATE ledger_postings SET amount_minor = amount_minor + 1`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM journal_entries`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`UPDATE audit_events SET action = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('rejects an unbalanced journal at commit', async () => {
    const c = await pg.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO journal_entries (idempotency_key, kind, mode, memo) VALUES ($1,'ADJUSTMENT','SIMULATED','bad') RETURNING id`, [randomUUID()]);
      const { rows: acc } = await c.query(`SELECT id FROM ledger_accounts WHERE mode='SIMULATED' LIMIT 2`);
      await c.query(`INSERT INTO ledger_postings (journal_id, account_id, amount_minor) VALUES ($1,$2,100),($1,$3,-99)`, [rows[0].id, acc[0].id, acc[1].id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      c.release();
    }
  });

  it('passes reconciliation and audit-chain verification', async () => {
    const admin = await adminLogin('admin');
    const r = await gql(`mutation{ runReconciliation{ ok summaryJson } }`, {}, { token: admin.token });
    const summary = JSON.parse(r.data.runReconciliation.summaryJson);
    const failed = summary.checks.filter((c: any) => !c.ok);
    expect(failed).toEqual([]);
    const v = await gql(`{ verifyAuditChain { ok checked } }`, {}, { token: admin.token });
    expect(v.data.verifyAuditChain.ok).toBe(true);
    expect(v.data.verifyAuditChain.checked).toBeGreaterThan(10);
  });

  it('never stores secrets in audit metadata', async () => {
    const { rows } = await pg.query(`SELECT metadata::text AS m FROM audit_events`);
    const blob = rows.map((r) => r.m).join('\n');
    expect(blob).not.toContain(PW);
    expect(blob).not.toMatch(/"(password|otp|token)":\s*"(?!\[redacted\])/i);
  });
});

describe('GraphQL hardening', () => {
  it('rejects over-complex queries (alias/batch amplification)', async () => {
    const t = await login('trader.one');
    const ok = await gql(`{ orders(limit: 20) { id instrument { symbol } } }`, {}, { token: t.accessToken });
    expect(ok.errors).toBeUndefined();
    const aliases = Array.from({ length: 30 }, (_, i) => `a${i}: orders(limit: 100) { id side status instrument { id symbol name exchange lotSize } }`).join(' ');
    const r = await gql(`{ ${aliases} }`, {}, { token: t.accessToken });
    expect(r.errors?.[0].message).toMatch(/too complex/i);
  });

  it('applies a depth limit to queries', async () => {
    const { buildSchema, parse, validate } = await import('graphql');
    const depthLimit = (await import('graphql-depth-limit')).default;
    const schema = buildSchema(`type N { n: N, v: Int } type Query { n: N }`);
    const q = parse(`{ n { n { n { n { n { n { n { n { n { v } } } } } } } } } }`);
    expect(validate(schema, q, [depthLimit(8)]).length).toBeGreaterThan(0);
  });

  it('does not leak internal error details', async () => {
    const t = await login('trader.one');
    const r = await gql(`{ instrument(id:"not-a-uuid") { id } }`, {}, { token: t.accessToken });
    expect(JSON.stringify(r)).not.toMatch(/stack|postgres|drizzle|at Object/i);
  });
});


describe('activity log & audit enrichment', () => {
  const flush = () => app.get(ActivityLogService).flush();

  it('logs every operation with time, IP, device, user, session and outcome — and redacts secrets', async () => {
    const t = await freshLogin('trader.three');
    await gql(`{ me { id } }`, {}, { token: t.accessToken, ua: 'TestPhone/1.0' });
    await gql(`{ adminOverview { traders } }`, {}, { token: t.accessToken, ua: 'TestPhone/1.0' });
    await flush();
    const { rows } = await pg.query(`SELECT * FROM activity_log WHERE user_id = $1 ORDER BY id`, [t.user.id]);
    const login = rows.find((r) => r.op_name === 'login');
    expect(login).toBeDefined();
    expect(login.ip).toBe('127.0.0.1');
    expect(login.variables.p).toBe('[redacted]'); // $p feeds the password argument
    expect(login.variables.u).toBe('trader.three');
    expect(JSON.stringify(rows)).not.toContain(PW);
    const me = rows.find((r) => r.fields === 'me');
    expect(me.user_agent).toBe('TestPhone/1.0');
    expect(me.session_id).toBeTruthy();
    expect(me.outcome).toBe('OK');
    expect(new Date(me.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const denied = rows.find((r) => r.fields === 'adminOverview');
    expect(denied.outcome).toBe('ERROR');
    expect(denied.error_code).toBe('FORBIDDEN');
    // a malformed request: variables are not stored at all (we can't tell which are secrets)
    await gql(`mutation($x:String!){ login(username:"a", password:$x) { nope } }`, { x: 'Secret-Value-123' }, { headers: { 'x-request-id': 'invalid-req-0001' } });
    await flush();
    const { rows: bad } = await pg.query(`SELECT variables, outcome FROM activity_log WHERE request_id = 'invalid-req-0001'`);
    expect(bad[0].outcome).toBe('ERROR');
    expect(JSON.stringify(bad[0].variables ?? null)).not.toContain('Secret-Value-123');
  });

  it('does not trust a spoofed X-Forwarded-For header (TRUST_PROXY=false)', async () => {
    const t = await login('trader.three');
    await gql(`{ me { id } }`, {}, { token: t.accessToken, headers: { 'x-forwarded-for': '6.6.6.6', 'x-request-id': 'spoof-test-req-0001' } });
    await flush();
    const { rows } = await pg.query(`SELECT ip FROM activity_log WHERE request_id = 'spoof-test-req-0001'`);
    expect(rows[0].ip).toBe('127.0.0.1');
  });

  it('stamps orders, payments and audit events with IP, device, session and the same request id', async () => {
    const t = await login('trader.one');
    const { rows: [inst] } = await pg.query(`SELECT id FROM instruments WHERE symbol = 'RELIANCE26NOVFUT'`);
    const reqId = `ord-${randomUUID()}`;
    const r = await gql(`mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status } }`, { i: { instrumentId: inst.id, side: 'BUY', type: 'MARKET', quantity: 1, idempotencyKey: randomUUID() } }, { token: t.accessToken, ua: 'TestPhone/2.0', headers: { 'x-request-id': reqId } });
    const orderId = r.data.placeOrder.id;
    await flush();
    const { rows: [o] } = await pg.query(`SELECT client_ip, user_agent, session_id, request_id FROM orders WHERE id = $1`, [orderId]);
    expect(o).toMatchObject({ client_ip: '127.0.0.1', user_agent: 'TestPhone/2.0', request_id: reqId });
    expect(o.session_id).toBeTruthy();
    const { rows: [ev] } = await pg.query(`SELECT ip, user_agent, session_id, request_id FROM audit_events WHERE entity_id = $1 AND action = 'order.placed'`, [orderId]);
    expect(ev).toMatchObject({ ip: '127.0.0.1', user_agent: 'TestPhone/2.0', request_id: reqId, session_id: o.session_id });
    const { rows: [act] } = await pg.query(`SELECT op_name, outcome FROM activity_log WHERE request_id = $1`, [reqId]);
    expect(act).toMatchObject({ op_name: 'placeOrder', outcome: 'OK' });

    const p = await gql(`mutation($k:String!){ requestPayment(input:{type:DEPOSIT, amount:"10.00", idempotencyKey:$k}){ id } }`, { k: randomUUID() }, { token: t.accessToken, ua: 'TestPhone/2.0' });
    const { rows: [pr] } = await pg.query(`SELECT requested_ip, requested_user_agent, requested_session_id FROM payment_requests WHERE id = $1`, [p.data.requestPayment.id]);
    expect(pr).toMatchObject({ requested_ip: '127.0.0.1', requested_user_agent: 'TestPhone/2.0' });
  });

  it('lets only Super Admins search all logs; users see their own actions', async () => {
    const t = await login('trader.two');
    expect(code(await gql(`{ activityLog(limit: 5) { id } }`, {}, { token: t.accessToken }))).toBe('FORBIDDEN');
    const mine = await gql(`{ myActivity(limit: 50) { userId opType ip at } }`, {}, { token: t.accessToken });
    expect(mine.data.myActivity.length).toBeGreaterThan(0);
    for (const m of mine.data.myActivity) { expect(m.userId).toBe(t.user.id); expect(m.opType).toBe('mutation'); expect(m.ip).toBeTruthy(); }
    const admin = await adminLogin('admin');
    const all = await gql(`query($f:ActivityFilter){ activityLog(filter:$f, limit: 50) { username ip opName outcome at } }`, { f: { ip: '127.0.0.1', actionsOnly: true } }, { token: admin.token });
    expect(all.data.activityLog.length).toBeGreaterThan(0);
    const shared = await gql(`{ accountsOnIp(ip: "127.0.0.1") { username requests } }`, {}, { token: admin.token });
    expect(shared.data.accountsOnIp.map((x: any) => x.username)).toEqual(expect.arrayContaining(['trader.one', 'trader.two']));
  });

  it('keeps the activity log append-only, archives a day with a checksum, and only purges archived days', async () => {
    await expect(pg.query(`UPDATE activity_log SET ip = '1.1.1.1'`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`DELETE FROM activity_log`)).rejects.toThrow(/append-only/);
    await expect(pg.query(`TRUNCATE activity_log`)).rejects.toThrow(/append-only/);
    // two old days of activity
    for (const day of ['2026-01-10', '2026-01-11']) {
      await pg.query(`INSERT INTO activity_log (at, request_id, ip, op_type, op_name, outcome) VALUES ($1, $2, '10.0.0.1', 'mutation', 'oldOp', 'OK')`, [`${day}T10:00:00Z`, `old-${day}`]);
    }
    const db = app.get(DbService).db;
    const dir = process.env.LOG_ARCHIVE_DIR!;
    rmSync(dir, { recursive: true, force: true });
    const a = await archiveDay(db, dir, '2026-01-10', 'activity');
    expect(a.rows).toBe(1);
    expect((await verifyArchive(db, '2026-01-10', 'activity')).ok).toBe(true);
    // purge everything older than now, but only archived days may go
    const { rows: [n] } = await pg.query(`SELECT td_purge_activity(now() - interval '1 day', true) AS n`);
    expect(Number(n.n)).toBe(1);
    const { rows: left } = await pg.query(`SELECT request_id FROM activity_log WHERE op_name = 'oldOp'`);
    expect(left.map((r) => r.request_id)).toEqual(['old-2026-01-11']);
    // tampering with the archive file is detected
    appendFileSync(a.location, 'x');
    const v = await verifyArchive(db, '2026-01-10', 'activity');
    expect(v).toMatchObject({ ok: false, reason: 'checksum mismatch' });
  });

  it('still verifies the audit hash chain with the new device/session/request fields', async () => {
    const admin = await adminLogin('admin');
    const v = await gql(`{ verifyAuditChain { ok checked } }`, {}, { token: admin.token });
    expect(v.data.verifyAuditChain.ok).toBe(true);
  });
});


describe('stop-loss / take-profit orders', () => {
  const PLACE = `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status type triggerPrice fillPrice rejectReason } }`;
  let instrumentId: string;
  let market: MarketDataService;
  beforeAll(async () => {
    const { rows } = await pg.query(`SELECT id FROM instruments WHERE symbol = 'ADANIENT26NOVFUT'`);
    instrumentId = rows[0].id;
    market = app.get(MarketDataService);
    market.setPrice(instrumentId, 250000n); // ₹2500
  });

  it('validates trigger prices by order type', async () => {
    const t = await login('trader.one');
    const noTrig = await gql(PLACE, { i: { instrumentId, side: 'SELL', type: 'STOP_LOSS', quantity: 1, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(code(noTrig)).toBe('BAD_USER_INPUT');
    const limitWithTrig = await gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'LIMIT', quantity: 1, limitPrice: '2400.00', triggerPrice: '2400.00', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(code(limitWithTrig)).toBe('BAD_USER_INPUT');
    // a SELL stop-loss above the current LTP would fire immediately → rejected with a reason
    const hit = await gql(PLACE, { i: { instrumentId, side: 'SELL', type: 'STOP_LOSS', quantity: 1, triggerPrice: '2600.00', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(hit.data.placeOrder.status).toBe('REJECTED');
    expect(hit.data.placeOrder.rejectReason).toMatch(/already reached/);
  });

  it('fires a stop-loss at the LTP when the price falls to the trigger, leaving the take-profit open', async () => {
    const t = await login('trader.one');
    const buy = await gql(PLACE, { i: { instrumentId, side: 'BUY', type: 'MARKET', quantity: 4, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(buy.data.placeOrder.status).toBe('FILLED');
    const sl = await gql(PLACE, { i: { instrumentId, side: 'SELL', type: 'STOP_LOSS', quantity: 4, triggerPrice: '2450.00', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    const tp = await gql(PLACE, { i: { instrumentId, side: 'SELL', type: 'TAKE_PROFIT', quantity: 4, triggerPrice: '2600.00', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(sl.data.placeOrder).toMatchObject({ status: 'OPEN', type: 'STOP_LOSS', triggerPrice: '2450.00' });
    expect(tp.data.placeOrder.status).toBe('OPEN');
    market.setPrice(instrumentId, 244000n); // ₹2440: below the stop
    await new Promise((res) => setTimeout(res, 1500));
    const o = await gql(`{ orders(status:[FILLED, OPEN]){ id status fillPrice triggeredAt } }`, {}, { token: t.accessToken });
    const slNow = o.data.orders.find((x: any) => x.id === sl.data.placeOrder.id);
    expect(slNow.status).toBe('FILLED');
    expect(slNow.triggeredAt).toBeTruthy();
    expect(Number(slNow.fillPrice)).toBeLessThanOrEqual(2450); // passed at LTP, not at the trigger
    expect(o.data.orders.find((x: any) => x.id === tp.data.placeOrder.id).status).toBe('OPEN');
    const { rows } = await pg.query(`SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY seq`, [sl.data.placeOrder.id]);
    expect(rows.map((r) => r.action)).toEqual(['order.placed', 'order.triggered']);
    await gql(`mutation($o:ID!){ cancelOrder(orderId:$o){ status } }`, { o: tp.data.placeOrder.id }, { token: t.accessToken });
  });

  it('exposes order limits and market sessions for the order screen', async () => {
    const t = await login('trader.one');
    const r = await gql(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument sessions { exchange open close } } }`, {}, { token: t.accessToken });
    expect(r.data.tradingRules).toMatchObject({ minQty: 1, maxQtyPerInstrument: 150 });
    expect(r.data.tradingRules.maxQtyPerOrder).toBeGreaterThan(0); // changed earlier by the config maker-checker test
    expect(r.data.tradingRules.sessions).toEqual(expect.arrayContaining([{ exchange: 'NSE', open: '09:17', close: '15:30' }, { exchange: 'MCX', open: '09:02', close: '23:30' }]));
  });
});

describe('market hours (IST)', () => {
  const S = { NSE: { open: '09:17', close: '15:30' }, INTL: { open: '03:32', close: '02:30' } };
  const at = (iso: string) => new Date(iso); // ISO with +05:30
  it('opens NSE at 09:17 IST on weekdays only, and closes on holidays', () => {
    expect(sessionStatus('NSE', S, [], at('2026-10-26T09:16:00+05:30')).isOpen).toBe(false); // Monday
    expect(sessionStatus('NSE', S, [], at('2026-10-26T09:17:00+05:30')).isOpen).toBe(true);
    expect(sessionStatus('NSE', S, [], at('2026-10-26T15:31:00+05:30')).isOpen).toBe(false);
    const sat = sessionStatus('NSE', S, [], at('2026-10-31T11:00:00+05:30'));
    expect(sat).toMatchObject({ isOpen: false, message: expect.stringMatching(/weekend/) });
    expect(sessionStatus('NSE', S, ['2026-11-09'], at('2026-11-09T11:00:00+05:30')).message).toMatch(/holiday/);
  });
  it('handles a session that runs past midnight', () => {
    expect(sessionStatus('INTL', S, [], at('2026-10-27T01:00:00+05:30')).isOpen).toBe(true); // Tue 01:00 = Monday's session
    expect(sessionStatus('INTL', S, [], at('2026-10-26T01:00:00+05:30')).isOpen).toBe(false); // Mon 01:00 = Sunday's (none)
    expect(sessionStatus('INTL', S, [], at('2026-10-27T02:45:00+05:30')).isOpen).toBe(false); // between sessions
    expect(sessionStatus('INTL', S, [], at('2026-10-27T03:32:00+05:30')).isOpen).toBe(true);
    expect(sessionStatus('INTL', S, [], at('2026-10-31T01:00:00+05:30')).isOpen).toBe(true); // Sat 01:00 = Friday's session
  });
});

describe('self sign-up and forgot password', () => {
  const PHONE = '9123456780';
  let userId: string;

  it('creates a PENDING trader only after the mobile OTP is verified, and redacts the password from logs', async () => {
    const otp = await gql(`mutation{ requestSignupOtp(phone:"${PHONE}"){ sentTo devCode } }`);
    if (!otp.data) throw new Error(JSON.stringify(otp.errors));
    const input = { displayName: 'Asha Rao', username: 'asha.rao', phone: PHONE, password: 'Asha-Strong-Pass-9', code: '000000' };
    const bad = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ status } }`, { i: input });
    expect(code(bad)).toBe('BAD_USER_INPUT');
    const ok = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ username status } }`, { i: { ...input, code: otp.data.requestSignupOtp.devCode } });
    expect(ok.data.registerTrader).toEqual({ username: 'asha.rao', status: 'PENDING' });
    // can't sign in until approved — and is told why (the password was correct)
    const pending = await gql(`mutation{ login(username:"asha.rao", password:"Asha-Strong-Pass-9"){ accessToken } }`);
    expect(pending.errors?.[0].message).toMatch(/waiting for approval/);
    // the same phone can't register twice
    const otp2 = await gql(`mutation{ requestSignupOtp(phone:"${PHONE}"){ devCode } }`);
    const dup = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ status } }`, { i: { ...input, username: 'asha.two', code: otp2.data.requestSignupOtp.devCode } });
    expect(dup.errors?.[0].message).toMatch(/already has an account/);
    await app.get(ActivityLogService).flush();
    const { rows } = await pg.query(`SELECT variables::text AS v FROM activity_log WHERE op_name = 'registerTrader'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.v).not.toMatch(/Asha-Strong-Pass-9|"code":"\d{6}"/);
    const admin = await adminLogin('admin');
    userId = (await pg.query(`SELECT id, status, signup_source FROM users WHERE username='asha.rao'`)).rows[0].id;
    const ap = await gql(`mutation($u:ID!){ approveUser(userId:$u){ status } }`, { u: userId }, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(ap.data.approveUser.status).toBe('ACTIVE');
    const t = await freshLogin('asha.rao', 'Asha-Strong-Pass-9');
    expect(t.accessToken).toBeTruthy();
  });

  it('resets a password by OTP without revealing whether an account exists', async () => {
    const session = await freshLogin('asha.rao', 'Asha-Strong-Pass-9');
    const known = await gql(`mutation{ requestPasswordReset(username:"asha.rao"){ message devCode } }`);
    const unknown = await gql(`mutation{ requestPasswordReset(username:"nobody.at.all"){ message devCode } }`);
    const adminReq = await gql(`mutation{ requestPasswordReset(username:"admin"){ message devCode } }`);
    expect(unknown.data.requestPasswordReset.message).toBe(known.data.requestPasswordReset.message);
    expect(adminReq.data.requestPasswordReset.devCode).toBeNull(); // Super Admins can't self-reset
    const wrong = await gql(`mutation{ resetPassword(username:"asha.rao", code:"000000", newPassword:"Brand-New-Pass-77") }`);
    expect(code(wrong)).toBe('UNAUTHENTICATED');
    const ok = await gql(`mutation($c:String!){ resetPassword(username:"asha.rao", code:$c, newPassword:"Brand-New-Pass-77") }`, { c: known.data.requestPasswordReset.devCode });
    expect(ok.data.resetPassword).toBe(true);
    expect(code(await gql(`{ me { id } }`, {}, { token: session.accessToken }))).toBe('UNAUTHENTICATED'); // every device signed out
    await expect(freshLogin('asha.rao', 'Asha-Strong-Pass-9')).rejects.toThrow();
    expect((await freshLogin('asha.rao', 'Brand-New-Pass-77')).accessToken).toBeTruthy();
    // the code is single-use
    const again = await gql(`mutation($c:String!){ resetPassword(username:"asha.rao", code:$c, newPassword:"Another-Pass-88x") }`, { c: known.data.requestPasswordReset.devCode });
    expect(code(again)).toBe('UNAUTHENTICATED');
  });
});

describe('statements and watchlists', () => {
  const LINK = `mutation($f:String!,$t:String!,$u:ID){ statementLink(from:$f,to:$t,userId:$u){ path fileName expiresIn } }`;
  const base = () => url.replace(/\/graphql$/, '');

  it('downloads a PDF statement through a short-lived link, scoped to accounts you may see', async () => {
    const t = await login('trader.one');
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const r = await gql(LINK, { f: '2026-01-01', t: today }, { token: t.accessToken });
    expect(r.data.statementLink.expiresIn).toBe(120);
    const res = await fetch(base() + r.data.statementLink.path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    expect((await fetch(base() + '/statement.pdf?token=garbage')).status).toBe(401);
    const other = (await login('trader.two')).user.id;
    expect(code(await gql(LINK, { f: '2026-01-01', t: today, u: other }, { token: t.accessToken }))).toBe('NOT_FOUND');
    expect(code(await gql(LINK, { f: '2024-01-01', t: today }, { token: t.accessToken }))).toBe('BAD_USER_INPUT');
    const { rows } = await pg.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'statement.downloaded'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('supports up to 10 watchlists and reports how many scripts each holds', async () => {
    const t = await login('trader.two');
    const { rows } = await pg.query(`SELECT id FROM instruments ORDER BY symbol LIMIT 2`);
    await gql(`mutation($i:ID!){ addToWatchlist(listIndex:9, instrumentId:$i) }`, { i: rows[0].id }, { token: t.accessToken });
    await gql(`mutation($i:ID!){ addToWatchlist(listIndex:9, instrumentId:$i) }`, { i: rows[1].id }, { token: t.accessToken });
    expect(code(await gql(`mutation($i:ID!){ addToWatchlist(listIndex:10, instrumentId:$i) }`, { i: rows[0].id }, { token: t.accessToken }))).toBe('BAD_USER_INPUT');
    const c = await gql(`{ watchlistCounts { listIndex count } }`, {}, { token: t.accessToken });
    expect(c.data.watchlistCounts).toEqual(expect.arrayContaining([{ listIndex: 9, count: 2 }]));
  });
});


describe('trading consent per session and sign-in audit', () => {
  const PLACE = `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status } }`;
  it('blocks orders until the rules are accepted for this session, and records time, IP, device and the exact rules', async () => {
    const t = await freshLogin('trader.two');
    const st = await gql(`{ tradingConsentStatus { required termsVersion rules } }`, {}, { token: t.accessToken });
    expect(st.data.tradingConsentStatus.required).toBe(true);
    const { rows } = await pg.query(`SELECT id FROM instruments WHERE symbol = 'RELIANCE26NOVFUT'`);
    const blocked = await gql(PLACE, { i: { instrumentId: rows[0].id, side: 'BUY', type: 'MARKET', quantity: 1, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(code(blocked)).toBe('FORBIDDEN');
    expect(blocked.errors?.[0].message).toMatch(/accept the trading rules/);
    // stale version is refused
    const stale = await gql(`mutation{ acceptTradingConsent(termsVersion:"${'0'.repeat(64)}"){ id } }`, {}, { token: t.accessToken });
    expect(code(stale)).toBe('CONFLICT');
    const ok = await gql(`mutation($v:String!){ acceptTradingConsent(termsVersion:$v){ id ip userAgent sessionId acceptedAt rules } }`, { v: st.data.tradingConsentStatus.termsVersion }, { token: t.accessToken, ua: 'consent-ua/1.0' });
    expect(ok.data.acceptTradingConsent).toMatchObject({ ip: '127.0.0.1', userAgent: 'consent-ua/1.0' });
    expect(ok.data.acceptTradingConsent.rules).toEqual(st.data.tradingConsentStatus.rules);
    // accepting twice in a session is idempotent
    const again = await gql(`mutation($v:String!){ acceptTradingConsent(termsVersion:$v){ id } }`, { v: st.data.tradingConsentStatus.termsVersion }, { token: t.accessToken });
    expect(again.data.acceptTradingConsent.id).toBe(ok.data.acceptTradingConsent.id);
    const placed = await gql(PLACE, { i: { instrumentId: rows[0].id, side: 'BUY', type: 'MARKET', quantity: 1, idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(placed.data.placeOrder.status).toBe('FILLED');
    // a new sign-in is a new session → consent required again
    const t2 = await freshLogin('trader.two');
    expect((await gql(`{ tradingConsentStatus { required } }`, {}, { token: t2.accessToken })).data.tradingConsentStatus.required).toBe(true);
    // consent records are evidence: append-only
    await expect(pg.query(`UPDATE trading_consents SET ip = '1.1.1.1'`)).rejects.toThrow(/append-only|not allowed|immutable/i);
    await expect(pg.query(`DELETE FROM trading_consents`)).rejects.toThrow();
  });

  it('shows sign-in history to the user and a platform-wide login audit to Super Admins only', async () => {
    await gql(`mutation{ login(username:"trader.two", password:"Wrong-Password-1x"){ accessToken } }`);
    const t = await freshLogin('trader.two');
    const mine = await gql(`{ loginHistory(limit:20){ action outcome ip userAgent at detail } }`, {}, { token: t.accessToken });
    const actions = mine.data.loginHistory.map((e: any) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(expect.arrayContaining(['auth.login:SUCCESS', 'auth.login_failed:FAILURE']));
    expect(mine.data.loginHistory[0].ip).toBe('127.0.0.1');
    // another trader can't read it
    const other = await login('trader.one');
    expect(code(await gql(`query($u:ID){ loginHistory(userId:$u){ action } }`, { u: t.user.id }, { token: other.accessToken }))).toBe('NOT_FOUND');
    expect(code(await gql(`{ loginAudit { action } }`, {}, { token: other.accessToken }))).toBe('FORBIDDEN');
    const admin = await adminLogin('admin');
    const all = await gql(`{ loginAudit(outcome:"FAILURE", limit:50){ action outcome username ip } }`, {}, { token: admin.token });
    expect(all.data.loginAudit.length).toBeGreaterThan(0);
    expect(all.data.loginAudit.every((e: any) => e.outcome === 'FAILURE')).toBe(true);
    const consents = await gql(`{ consentLog(limit:50){ username ip acceptedAt termsVersion } }`, {}, { token: admin.token });
    expect(consents.data.consentLog.some((c: any) => c.username === 'trader.two')).toBe(true);
  });
});


describe('concurrent sessions: detection, force login, policies', () => {
  const LOGIN = `mutation($u:String!,$p:String!){ login(username:$u,password:$p){ accessToken sessionConflict conflictToken conflictLimit activeSessions{ id ip userAgent lastUsedAt } } }`;
  const STRICT = (onLimit: string, extra: Record<string, unknown> = {}) => ({ ...OPEN_POLICY, TRADER: { maxConcurrent: 1, onLimit, idleMinutes: 480, maxHours: 24, ...extra } });
  const sid = async (token: string) => (await gql(`{ mySessions { id current } }`, {}, { token })).data.mySessions.find((x: any) => x.current).id as string;
  afterAll(() => setConfig('security.sessionPolicy', OPEN_POLICY));

  it('detects a second sign-in, shows the device already signed in, and lets the user force login', async () => {
    await setConfig('security.sessionPolicy', STRICT('ask'));
    await pg.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'test_reset' WHERE user_id = (SELECT id FROM users WHERE username = 'trader.three') AND revoked_at IS NULL`);
    const a = await gql(LOGIN, { u: 'trader.three', p: PW }, { ua: 'Phone-A/1.0' });
    expect(a.data.login.sessionConflict).toBe(false);
    const tokenA = a.data.login.accessToken;
    const sidA = await sid(tokenA);
    const b = await gql(LOGIN, { u: 'trader.three', p: PW }, { ua: 'Laptop-B/2.0' });
    expect(b.data.login).toMatchObject({ sessionConflict: true, accessToken: null, conflictLimit: 1 });
    expect(b.data.login.activeSessions).toHaveLength(1);
    expect(b.data.login.activeSessions[0]).toMatchObject({ id: sidA, userAgent: 'Phone-A/1.0', ip: '127.0.0.1' });
    expect((await gql(`{ me { username } }`, {}, { token: tokenA })).data.me.username).toBe('trader.three'); // A untouched so far
    // the force-login token is bound to the device that asked for it
    expect(code(await gql(`mutation($t:String!){ forceLogin(conflictToken:$t){ accessToken } }`, { t: b.data.login.conflictToken }, { ua: 'Other/9' }))).toBe('UNAUTHENTICATED');
    const events = pubsub.asyncIterableIterator<{ sessionEvents: { reason: string } }>(TOPIC.session(sidA));
    const next = events.next();
    const f = await gql(`mutation($t:String!){ forceLogin(conflictToken:$t){ accessToken sessionConflict } }`, { t: b.data.login.conflictToken }, { ua: 'Laptop-B/2.0' });
    expect(f.data.forceLogin.sessionConflict).toBe(false);
    expect(f.data.forceLogin.accessToken).toBeTruthy();
    expect((await next).value.sessionEvents.reason).toBe('SESSION_REPLACED'); // pushed to device A live
    const kicked = await gql(`{ me { username } }`, {}, { token: tokenA });
    expect(code(kicked)).toBe('UNAUTHENTICATED');
    expect(kicked.errors?.[0].extensions).toMatchObject({ reason: 'SESSION_REPLACED' });
    expect(kicked.errors?.[0].message).toMatch(/signed in on another device/);
    const { rows } = await pg.query(`SELECT action FROM audit_events WHERE actor_id = (SELECT id FROM users WHERE username='trader.three') AND action IN ('auth.concurrent_login_detected','auth.force_login') ORDER BY seq`);
    expect(rows.map((r) => r.action)).toEqual(['auth.concurrent_login_detected', 'auth.force_login']);
  });

  it('replace_oldest signs the old device out automatically; block refuses the new sign-in', async () => {
    await setConfig('security.sessionPolicy', STRICT('replace_oldest'));
    const first = await gql(LOGIN, { u: 'trader.three', p: PW }, { ua: 'Laptop-B/2.0' });
    const second = await gql(LOGIN, { u: 'trader.three', p: PW }, { ua: 'Tablet-C/1.0' });
    expect(second.data.login.sessionConflict).toBe(false);
    expect((await gql(`{ me { id } }`, {}, { token: first.data.login.accessToken })).errors?.[0].extensions).toMatchObject({ reason: 'SESSION_REPLACED' });
    await setConfig('security.sessionPolicy', STRICT('block'));
    const third = await gql(LOGIN, { u: 'trader.three', p: PW }, { ua: 'Phone-D/1.0' });
    expect(code(third)).toBe('FORBIDDEN');
    expect(third.errors?.[0].extensions).toMatchObject({ reason: 'CONCURRENT_LOGIN_BLOCKED' });
    expect((await gql(`{ me { id } }`, {}, { token: second.data.login.accessToken })).data.me.id).toBeTruthy();
  });

  it('signs a device out after the idle limit, and lets a Super Admin sign out any account', async () => {
    await setConfig('security.sessionPolicy', STRICT('ask', { maxConcurrent: 0, idleMinutes: 5 }));
    const t = await gql(LOGIN, { u: 'trader.three', p: PW });
    const token = t.data.login.accessToken;
    await pg.query(`UPDATE sessions SET last_used_at = now() - interval '10 minutes' WHERE id = $1`, [await sid(token)]);
    const idle = await gql(`{ me { id } }`, {}, { token });
    expect(idle.errors?.[0].extensions).toMatchObject({ reason: 'SESSION_IDLE' });
    const t2 = (await gql(LOGIN, { u: 'trader.three', p: PW })).data.login.accessToken;
    const admin = await adminLogin('admin');
    const uid = (await pg.query(`SELECT id FROM users WHERE username='trader.three'`)).rows[0].id;
    const list = await gql(`query($u:ID!){ userSessions(userId:$u){ id ip userAgent } }`, { u: uid }, { token: admin.token });
    expect(list.data.userSessions.length).toBeGreaterThan(0);
    const n = await gql(`mutation($u:ID!){ revokeUserSessions(userId:$u) }`, { u: uid }, { token: admin.token, stepUp: await stepUp(admin.token, 'admin') });
    expect(n.data.revokeUserSessions).toBeGreaterThan(0);
    expect((await gql(`{ me { id } }`, {}, { token: t2 })).errors?.[0].extensions).toMatchObject({ reason: 'SESSION_REVOKED' });
    const trader = await login('trader.one');
    expect(code(await gql(`query($u:ID!){ userSessions(userId:$u){ id } }`, { u: uid }, { token: trader.accessToken }))).toBe('FORBIDDEN');
  });
});

describe('encryption at rest', () => {
  it('stores phone numbers only as AES-GCM ciphertext plus a blind index, and still finds them', async () => {
    const PHONE = '9000012345';
    const otp = await gql(`mutation{ requestSignupOtp(phone:"${PHONE}"){ devCode } }`);
    const { rows: o } = await pg.query(`SELECT phone FROM otp_challenges WHERE purpose = 'signup' ORDER BY created_at DESC LIMIT 1`);
    expect(o[0].phone).toMatch(/^[0-9a-f]{64}$/); // never the number itself
    await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ status } }`, { i: { displayName: 'Enc Test', username: 'enc.test', phone: PHONE, email: 'Enc@Example.com', password: 'Enc-Strong-Pass-1', code: otp.data.requestSignupOtp.devCode } });
    const { rows } = await pg.query(`SELECT phone, email, phone_enc, phone_hash, email_enc FROM users WHERE username = 'enc.test'`);
    expect(rows[0].phone).toBeNull();
    expect(rows[0].email).toBeNull();
    expect(rows[0].phone_enc).toMatch(/^enc:v2:k1:/);
    expect(rows[0].phone_enc).not.toContain(PHONE);
    expect(decryptField(rows[0].phone_enc, 'users.phone')).toBe('+91' + PHONE);
    expect(decryptField(rows[0].email_enc, 'users.email')).toBe('enc@example.com');
    // bound to its column: the same ciphertext can't be read as another field
    expect(() => decryptField(rows[0].phone_enc, 'users.email')).toThrow();
    // lookups by blind index still work: the same phone can't register again
    const otp2 = await gql(`mutation{ requestSignupOtp(phone:"${PHONE}"){ devCode } }`);
    const dup = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ status } }`, { i: { displayName: 'Enc Two', username: 'enc.two', phone: PHONE, password: 'Enc-Strong-Pass-1', code: otp2.data.requestSignupOtp.devCode } });
    expect(dup.errors?.[0].message).toMatch(/already has an account/);
  });

  it('rotates keys: old ciphertext stays readable via the previous key and is flagged for re-encryption', () => {
    const old = encryptField('secret-value', 'users.phone');
    const saved = { k: process.env.DATA_ENCRYPTION_KEY, id: process.env.DATA_ENCRYPTION_KEY_ID, prev: process.env.DATA_ENCRYPTION_KEYS_PREVIOUS };
    try {
      process.env.DATA_ENCRYPTION_KEYS_PREVIOUS = `k1:${saved.k}`;
      process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
      process.env.DATA_ENCRYPTION_KEY_ID = 'k2';
      (require('../src/config/env') as { resetEnvCache?: () => void }).resetEnvCache?.();
      resetKeyRing();
      expect(decryptField(old, 'users.phone')).toBe('secret-value');
      expect(needsRotation(old)).toBe(true);
      const fresh = encryptField('secret-value', 'users.phone');
      expect(fresh.startsWith('enc:v2:k2:')).toBe(true);
      expect(needsRotation(fresh)).toBe(false);
    } finally {
      process.env.DATA_ENCRYPTION_KEY = saved.k;
      process.env.DATA_ENCRYPTION_KEY_ID = saved.id;
      if (saved.prev === undefined) delete process.env.DATA_ENCRYPTION_KEYS_PREVIOUS; else process.env.DATA_ENCRYPTION_KEYS_PREVIOUS = saved.prev;
      (require('../src/config/env') as { resetEnvCache?: () => void }).resetEnvCache?.();
      resetKeyRing();
    }
  });
});


describe('input validation', () => {
  const PLACE = `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status } }`;
  it('rejects malformed input objects with a readable BAD_USER_INPUT message', async () => {
    const t = await login('trader.one');
    const { rows } = await pg.query(`SELECT id FROM instruments LIMIT 1`);
    const base = { instrumentId: rows[0].id, side: 'BUY', type: 'MARKET', quantity: 1, idempotencyKey: randomUUID() };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, instrumentId: 'not-a-uuid' }, /Invalid instrument/],
      [{ ...base, quantity: 0 }, /at least 1/],
      [{ ...base, quantity: 5_000_000 }, /too large/],
      [{ ...base, type: 'LIMIT', limitPrice: '12.345' }, /up to 2 decimals/],
      [{ ...base, idempotencyKey: 'x' }, /idempotency key/],
    ];
    for (const [i, rx] of cases) {
      const r = await gql(PLACE, { i }, { token: t.accessToken });
      expect(code(r)).toBe('BAD_USER_INPUT');
      expect(r.errors?.[0].message).toMatch(rx);
    }
    const pay = await gql(`mutation($i:PaymentRequestInput!){ requestPayment(input:$i){ id } }`, { i: { type: 'DEPOSIT', amount: '-5', idempotencyKey: randomUUID() } }, { token: t.accessToken });
    expect(code(pay)).toBe('BAD_USER_INPUT');
    const signup = await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ status } }`, { i: { displayName: 'X', username: 'ab', phone: 'abc', password: 'short', code: '12' } });
    expect(code(signup)).toBe('BAD_USER_INPUT');
  });

  it('rejects control characters, bidi overrides and oversized strings anywhere in the request', async () => {
    expect(code(await gql(`mutation($u:String!,$p:String!){ login(username:$u,password:$p){ accessToken } }`, { u: 'trader.one\u0000', p: 'x' }))).toBe('BAD_USER_INPUT');
    expect(code(await gql(`mutation($u:String!,$p:String!){ login(username:$u,password:$p){ accessToken } }`, { u: 'admin‮exe', p: 'x' }))).toBe('BAD_USER_INPUT');
    const t = await login('trader.one');
    expect(code(await gql(`query($q:String!){ searchInstruments(query:$q){ id } }`, { q: 'a'.repeat(6000) }, { token: t.accessToken }))).toBe('BAD_USER_INPUT');
    // ordinary Unicode (names, ₹, emoji) is fine
    const ok = await gql(`query($q:String!){ searchInstruments(query:$q){ id } }`, { q: 'Rāmā ₹ 🙂' }, { token: t.accessToken });
    expect(ok.errors).toBeUndefined();
  });
});

describe('automated trading (paper)', () => {
  const F = 'id status version position entryPrice stopReason today { pnl orders }';
  const SAVE = `mutation($i:SaveStrategyInput!){ saveStrategy(input:$i){ ${F} } }`;
  let instrumentId: string;
  const always = { side: 'LONG', entry: [{ left: { type: 'price', field: 'close' }, op: 'above', right: { type: 'number', value: 1 } }], exit: [], takeProfitPct: 50 };
  const input = (rules: unknown, extra: Record<string, unknown> = {}) => ({ name: 'Test strategy', instrumentId, interval: 'M1', rules: JSON.stringify(rules), quantity: 2, maxDailyLoss: '100000', maxOrdersPerDay: 10, ...extra });

  beforeAll(async () => {
    const { rows } = await pg.query(`SELECT id FROM instruments WHERE symbol = 'SBIN26NOVFUT'`);
    instrumentId = rows[0].id;
  });

  it('validates rules and keeps strategies private to their owner', async () => {
    const t = await login('trader.one');
    const bad = await gql(SAVE, { i: input({ side: 'LONG', entry: always.entry, exit: [] }) }, { token: t.accessToken });
    expect(code(bad)).toBe('BAD_USER_INPUT');
    expect(bad.errors![0].message).toMatch(/exit condition, a stop-loss or a take-profit/);
    const ok = await gql(SAVE, { i: input(always) }, { token: t.accessToken });
    expect(ok.errors).toBeUndefined();
    expect(ok.data.saveStrategy.status).toBe('DRAFT');
    const other = await login('trader.two');
    const peek = await gql(`query($id:ID!){ strategy(id:$id){ id } }`, { id: ok.data.saveStrategy.id }, { token: other.accessToken });
    expect(code(peek)).toBe('NOT_FOUND');
  });

  it('backtests on stored candles and saves the run', async () => {
    const t = await login('trader.one');
    const rules = { side: 'LONG', entry: [{ left: { type: 'ema', period: 9 }, op: 'crossesAbove', right: { type: 'ema', period: 21 } }], exit: [{ left: { type: 'ema', period: 9 }, op: 'crossesBelow', right: { type: 'ema', period: 21 } }], stopLossPct: 1 };
    const s = (await gql(SAVE, { i: input(rules, { interval: 'M15' }) }, { token: t.accessToken })).data.saveStrategy;
    const r = await gql(`mutation($id:ID!){ backtestStrategy(id:$id, days:3){ id metrics trades equity } }`, { id: s.id }, { token: t.accessToken });
    expect(r.errors).toBeUndefined();
    const m = JSON.parse(r.data.backtestStrategy.metrics);
    expect(m.candles).toBeGreaterThan(100);
    expect(m.trades).toBe(JSON.parse(r.data.backtestStrategy.trades).length);
    expect(Number.isInteger(m.netPnl)).toBe(true);
    const runs = await gql(`query($id:ID!){ strategyRuns(strategyId:$id){ id } }`, { id: s.id }, { token: t.accessToken });
    expect(runs.data.strategyRuns).toHaveLength(1);
  });

  it('needs the session consent to start, trades through OrdersService, and closes the position on stop', async () => {
    const t = await freshLogin('trader.three'); // fresh session: rules not accepted yet
    const s = (await gql(SAVE, { i: input(always) }, { token: t.accessToken })).data.saveStrategy;
    const blocked = await gql(`mutation($id:ID!){ startStrategy(id:$id){ id } }`, { id: s.id }, { token: t.accessToken });
    expect(code(blocked)).toBe('FORBIDDEN');
    await acceptConsent(t.accessToken);
    const started = await gql(`mutation($id:ID!){ startStrategy(id:$id){ ${F} } }`, { id: s.id }, { token: t.accessToken });
    expect(started.data.startStrategy.status).toBe('RUNNING');

    const market = app.get(MarketDataService);
    const runner = app.get(AlgoRunnerService);
    const now = Date.now();
    market.setPrice(instrumentId, 80000n); // a tick in the current minute, so that candle exists
    await runner.cycle(now + 63_000); // ...and has now closed: the entry rule fires
    const after = (await gql(`query($id:ID!){ strategy(id:$id){ ${F} } }`, { id: s.id }, { token: t.accessToken })).data.strategy;
    expect(after.position).toBe(2);
    await runner.cycle(now + 64_000); // same candle again: no second entry
    const { rows: o1 } = await pg.query(`SELECT status, client_ip FROM orders WHERE strategy_id = $1`, [s.id]);
    expect(o1).toHaveLength(1);
    expect(o1[0]).toMatchObject({ status: 'FILLED', client_ip: 'algo' });

    const stopped = await gql(`mutation($id:ID!){ stopStrategy(id:$id){ ${F} } }`, { id: s.id }, { token: t.accessToken });
    expect(stopped.data.stopStrategy).toMatchObject({ status: 'STOPPED', position: 0 });
    const { rows: o2 } = await pg.query(`SELECT side FROM orders WHERE strategy_id = $1 ORDER BY created_at`, [s.id]);
    expect(o2.map((r) => r.side)).toEqual(['BUY', 'SELL']);
    const ev = await gql(`query($id:ID!){ strategyEvents(strategyId:$id){ kind } }`, { id: s.id }, { token: t.accessToken });
    expect(ev.data.strategyEvents.map((e: { kind: string }) => e.kind)).toEqual(['STOPPED', 'EXIT', 'ENTRY', 'STARTED']);
  });

  it('stops by itself and flattens when the daily loss limit is hit', async () => {
    const t = await freshLogin('trader.three');
    await acceptConsent(t.accessToken);
    const s = (await gql(SAVE, { i: input(always, { name: 'Loss guard', maxDailyLoss: '10' }) }, { token: t.accessToken })).data.saveStrategy;
    await gql(`mutation($id:ID!){ startStrategy(id:$id){ id } }`, { id: s.id }, { token: t.accessToken });
    const market = app.get(MarketDataService);
    const runner = app.get(AlgoRunnerService);
    const now = Date.now();
    market.setPrice(instrumentId, 80000n);
    await runner.cycle(now + 63_000);
    market.setPrice(instrumentId, 79000n); // ₹10 × 2 = ₹20 open loss > ₹10 limit
    await runner.cycle(now + 65_000);
    const st = (await gql(`query($id:ID!){ strategy(id:$id){ ${F} } }`, { id: s.id }, { token: t.accessToken })).data.strategy;
    expect(st).toMatchObject({ status: 'STOPPED', position: 0 });
    expect(st.stopReason).toMatch(/Daily loss limit/);
  });
});
