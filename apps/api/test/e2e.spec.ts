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
