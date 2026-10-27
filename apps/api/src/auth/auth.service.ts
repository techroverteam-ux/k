import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { authenticator } from 'otplib';
import type { Actor } from '../common/context';
import { decryptSecret, encryptSecret, numericCode, peppered, randomToken, safeEqualHex } from '../common/crypto';
import { AppError, badInput, notFound, unauthenticated } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '../config-mgmt/config.service';
import { env } from '../config/env';
import { DbService, type Tx } from '../db/db';
import { otpChallenges, sessions, users, type UserRow } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PasswordService } from './password.service';
import { maskPhone, SmsProvider } from './sms.provider';
import { requestContext } from '../common/request-context';
import { pubsub, TOPIC } from '../notifications/notifications.service';
import { policyFor, REVOKE_REASON, signedOutMessage, type RolePolicy } from './session-policy';
import { USERNAME_RE } from '../users/users.service';
import { emailColumns, emailIndex, normalizeEmail, normalizePhone, phoneColumns, phoneIndex, readPhone } from '../common/pii';

authenticator.options = { window: 1, step: 30 };

export interface ClientMeta {
  ip: string;
  userAgent: string;
  deviceName?: string;
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  sessionId: string;
}

const GENERIC_LOGIN_ERROR = 'Invalid username or password.';
const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 3;

@Injectable()
export class AuthService {
  private readonly jwt = new JwtService({});

  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly sms: SmsProvider,
  ) {}

  // ---------------------------------------------------------------- tokens

  private signAccess(u: Pick<UserRow, 'id' | 'role'>, sessionId: string, mfa: boolean) {
    const ttl = env().ACCESS_TOKEN_TTL_SEC;
    const accessToken = this.jwt.sign(
      { sub: u.id, role: u.role, sid: sessionId, mfa },
      { secret: env().JWT_ACCESS_SECRET, expiresIn: ttl, algorithm: 'HS256', issuer: 'tradedesk', audience: 'tradedesk-api' },
    );
    return { accessToken, expiresIn: ttl };
  }

  /** Verify an access token and confirm its session is still live and the user active. */
  async verifyAccess(token: string): Promise<Actor> {
    let p: { sub: string; role: Actor['role']; sid: string; mfa: boolean };
    try {
      p = this.jwt.verify(token, { secret: env().JWT_ACCESS_SECRET, algorithms: ['HS256'], issuer: 'tradedesk', audience: 'tradedesk-api' });
    } catch {
      throw unauthenticated();
    }
    const [row] = await this.dbs.db
      .select({ status: users.status, role: users.role, revokedAt: sessions.revokedAt, revokedReason: sessions.revokedReason, expiresAt: sessions.expiresAt, lastUsedAt: sessions.lastUsedAt, mfa: sessions.mfaVerified })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, p.sid), eq(sessions.userId, p.sub)))
      .limit(1);
    if (!row || row.status !== 'ACTIVE') throw unauthenticated();
    if (row.revokedAt) throw this.endedError(row.revokedReason);
    if (row.expiresAt < new Date()) throw this.endedError('expired');
    const pol = policyFor(await this.config.get('security.sessionPolicy'), row.role);
    const idleFor = Date.now() - row.lastUsedAt.getTime();
    if (idleFor > pol.idleMinutes * 60_000) {
      await this.revokeSessions(eq(sessions.id, p.sid), REVOKE_REASON.idle);
      throw this.endedError(REVOKE_REASON.idle);
    }
    // Keep "last active" fresh without a write on every request.
    if (idleFor > 60_000) void this.dbs.db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, p.sid)).catch(() => undefined);
    // Role comes from the DB, not the token, so demotions take effect immediately.
    return { userId: p.sub, role: row.role, sessionId: p.sid, mfaVerified: row.mfa };
  }

  private async createSession(tx: Tx, u: UserRow, meta: ClientMeta, mfaVerified: boolean): Promise<IssuedTokens> {
    const secret = randomToken(32);
    const pol = policyFor(await this.config.get('security.sessionPolicy'), u.role);
    const expiresAt = new Date(Date.now() + Math.min(env().REFRESH_TOKEN_TTL_DAYS * 24, pol.maxHours) * 3_600_000);
    const prior = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, u.id), eq(sessions.userAgent, meta.userAgent.slice(0, 400))))
      .limit(1);
    const [s] = await tx
      .insert(sessions)
      .values({
        userId: u.id,
        familyId: sql`gen_random_uuid()` as unknown as string,
        refreshTokenHash: 'pending'.padEnd(64, '0'),
        deviceName: meta.deviceName?.slice(0, 120),
        userAgent: meta.userAgent.slice(0, 400),
        ip: meta.ip,
        mfaVerified,
        expiresAt,
      })
      .returning({ id: sessions.id });
    const refreshToken = `${s.id}.${secret}`;
    requestContext.setActor({ userId: u.id, role: u.role, sessionId: s.id });
    await tx.update(sessions).set({ refreshTokenHash: peppered(refreshToken) }).where(eq(sessions.id, s.id));
    if (!prior.length) {
      await this.notifications.notify(
        tx,
        u.id,
        'security.new_device',
        'New sign-in',
        `A new device signed in to your account (${meta.deviceName ?? meta.userAgent.slice(0, 60)}, IP ${meta.ip}). If this wasn't you, revoke it in Security settings and change your password.`,
      );
    }
    return { ...this.signAccess(u, s.id, mfaVerified), refreshToken, sessionId: s.id };
  }

  /** Refresh-token rotation with reuse detection: replaying an old token revokes the session. */
  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedTokens> {
    const sid = refreshToken.split('.')[0];
    if (!/^[0-9a-f-]{36}$/.test(sid)) throw unauthenticated();
    return this.dbs.serializable(async (tx) => {
      const [s] = await tx.select().from(sessions).where(eq(sessions.id, sid)).for('update');
      if (!s) throw unauthenticated();
      if (s.revokedAt) throw this.endedError(s.revokedReason);
      if (s.expiresAt < new Date()) throw this.endedError('expired');
      if (!safeEqualHex(s.refreshTokenHash, peppered(refreshToken))) {
        await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'refresh_reuse' }).where(eq(sessions.id, s.id));
        await this.audit.record(tx, { actor: { userId: s.userId, role: 'TRADER' }, action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: s.id, outcome: 'DENIED', ip: meta.ip });
        await this.notifications.notify(tx, s.userId, 'security.token_reuse', 'Session revoked', 'We detected reuse of an old sign-in token and signed that device out. Please change your password if this was not you.');
        // commit the revocation, then fail
        return null as unknown as IssuedTokens;
      }
      const [u] = await tx.select().from(users).where(eq(users.id, s.userId));
      if (!u || u.status !== 'ACTIVE') throw unauthenticated();
      const pol = policyFor(await this.config.get('security.sessionPolicy'), u.role);
      if (Date.now() - s.lastUsedAt.getTime() > pol.idleMinutes * 60_000) {
        await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: REVOKE_REASON.idle }).where(eq(sessions.id, s.id));
        return { idle: true } as unknown as IssuedTokens;
      }
      requestContext.setActor({ userId: u.id, role: u.role, sessionId: s.id });
      const newToken = `${s.id}.${randomToken(32)}`;
      await tx
        .update(sessions)
        .set({ refreshTokenHash: peppered(newToken), lastUsedAt: new Date(), rotatedAt: new Date(), ip: meta.ip })
        .where(eq(sessions.id, s.id));
      return { ...this.signAccess(u, s.id, s.mfaVerified), refreshToken: newToken, sessionId: s.id };
    }).then((r) => {
      if (!r) throw unauthenticated();
      if ((r as unknown as { idle?: boolean }).idle) throw this.endedError(REVOKE_REASON.idle);
      return r;
    });
  }

  // ---------------------------------------------------------------- password login

  async login(username: string, password: string, meta: ClientMeta) {
    const uname = username.trim().toLowerCase();
    const [u] = await this.dbs.db.select().from(users).where(eq(users.username, uname)).limit(1);
    const ok = await this.passwords.verify(u?.passwordHash, password);

    // Attribute the attempt (even a failed one) to the targeted account so it shows in its activity log.
    if (u) requestContext.setActor({ userId: u.id, role: u.role });
    if (!u) {
      await this.audit.recordStandalone({ action: 'auth.login_failed', outcome: 'FAILURE', ip: meta.ip, metadata: { reason: 'unknown_user' } });
      throw new AppError('UNAUTHENTICATED', GENERIC_LOGIN_ERROR);
    }
    if (u.lockedUntil && u.lockedUntil > new Date()) {
      await this.audit.recordStandalone({ actor: { userId: u.id, role: u.role }, action: 'auth.login_locked', outcome: 'DENIED', ip: meta.ip });
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
    }
    if (!ok) {
      const max = await this.config.get('security.maxFailedLogins');
      const mins = await this.config.get('security.lockoutMinutes');
      const fails = u.failedLoginCount + 1;
      await this.dbs.db
        .update(users)
        .set({ failedLoginCount: fails >= max ? 0 : fails, lockedUntil: fails >= max ? new Date(Date.now() + mins * 60_000) : u.lockedUntil })
        .where(eq(users.id, u.id));
      await this.audit.recordStandalone({ actor: { userId: u.id, role: u.role }, action: 'auth.login_failed', outcome: 'FAILURE', ip: meta.ip, metadata: { fails } });
      throw new AppError('UNAUTHENTICATED', GENERIC_LOGIN_ERROR);
    }
    if (u.status !== 'ACTIVE') {
      await this.audit.recordStandalone({ actor: { userId: u.id, role: u.role }, action: 'auth.login_inactive', outcome: 'DENIED', ip: meta.ip, metadata: { status: u.status } });
      // The password was correct, so it's safe to say why (this doesn't reveal anything to a stranger).
      if (u.status === 'PENDING') throw new AppError('FORBIDDEN', 'Your account is waiting for approval. You can sign in once an administrator approves it.');
      throw new AppError('UNAUTHENTICATED', GENERIC_LOGIN_ERROR);
    }

    await this.dbs.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, u.id));

    if (u.mfaEnabled) {
      const mfaToken = this.jwt.sign(
        { sub: u.id, purpose: 'mfa', ua: peppered(meta.userAgent).slice(0, 16) },
        { secret: env().JWT_STEPUP_SECRET, expiresIn: 300, algorithm: 'HS256', issuer: 'tradedesk' },
      );
      return { mfaRequired: true as const, mfaToken, user: u };
    }
    const r = await this.admitSession(u, meta, { mfaVerified: false, method: 'password' });
    return { mfaRequired: false as const, ...r, user: u };
  }

  async completeMfaLogin(mfaToken: string, code: string, meta: ClientMeta) {
    let p: { sub: string; purpose: string; ua: string };
    try {
      p = this.jwt.verify(mfaToken, { secret: env().JWT_STEPUP_SECRET, algorithms: ['HS256'], issuer: 'tradedesk' });
    } catch {
      throw unauthenticated();
    }
    if (p.purpose !== 'mfa' || p.ua !== peppered(meta.userAgent).slice(0, 16)) throw unauthenticated();
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, p.sub));
    if (!u || u.status !== 'ACTIVE' || !u.mfaEnabled || !u.mfaSecretEnc) throw unauthenticated();
    requestContext.setActor({ userId: u.id, role: u.role });
    if (!authenticator.check(code.trim(), decryptSecret(u.mfaSecretEnc))) {
      await this.audit.recordStandalone({ actor: { userId: u.id, role: u.role }, action: 'auth.mfa_failed', outcome: 'FAILURE', ip: meta.ip });
      throw new AppError('UNAUTHENTICATED', 'Invalid authentication code.');
    }
    const r = await this.admitSession(u, meta, { mfaVerified: true, method: 'mfa' });
    return { ...r, user: u };
  }

  // ---------------------------------------------------------------- MFA enrolment

  async beginMfaEnrollment(actor: Actor) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, actor.userId));
    if (u.mfaEnabled) throw badInput('MFA is already enabled.');
    const secret = authenticator.generateSecret(20);
    await this.dbs.db.update(users).set({ mfaSecretEnc: encryptSecret(secret) }).where(eq(users.id, u.id));
    return { secret, otpauthUrl: authenticator.keyuri(u.username, env().APP_NAME, secret) };
  }

  async confirmMfaEnrollment(actor: Actor, code: string, ip: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, actor.userId));
    if (!u.mfaSecretEnc || u.mfaEnabled) throw badInput('Start MFA enrolment first.');
    if (!authenticator.check(code.trim(), decryptSecret(u.mfaSecretEnc))) throw badInput('Invalid code. Check your authenticator app time.');
    await this.dbs.db.transaction(async (tx) => {
      await tx.update(users).set({ mfaEnabled: true }).where(eq(users.id, u.id));
      await tx.update(sessions).set({ mfaVerified: true }).where(eq(sessions.id, actor.sessionId));
      await this.audit.record(tx, { actor, action: 'auth.mfa_enabled', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip });
    });
    return true;
  }

  // ---------------------------------------------------------------- step-up

  /** Re-authenticate for a sensitive operation. Returns a short-lived token bound to this session. */
  async stepUp(actor: Actor, input: { password?: string; totp?: string }, ip: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, actor.userId));
    let ok = false;
    if (u.mfaEnabled && u.mfaSecretEnc && input.totp) ok = authenticator.check(input.totp.trim(), decryptSecret(u.mfaSecretEnc));
    else if (input.password && !u.mfaEnabled) ok = await this.passwords.verify(u.passwordHash, input.password);
    else if (input.password && u.mfaEnabled) throw badInput('Use your authenticator code.');
    await this.audit.recordStandalone({ actor, action: 'auth.step_up', outcome: ok ? 'SUCCESS' : 'FAILURE', ip });
    if (!ok) throw new AppError('UNAUTHENTICATED', 'Verification failed.');
    const ttl = env().STEPUP_TTL_SEC;
    return {
      token: this.jwt.sign({ sub: actor.userId, sid: actor.sessionId, purpose: 'stepup' }, { secret: env().JWT_STEPUP_SECRET, expiresIn: ttl, algorithm: 'HS256', issuer: 'tradedesk' }),
      expiresIn: ttl,
    };
  }

  verifyStepUp(actor: Actor, token?: string): boolean {
    if (!token) return false;
    try {
      const p = this.jwt.verify(token, { secret: env().JWT_STEPUP_SECRET, algorithms: ['HS256'], issuer: 'tradedesk' }) as { sub: string; sid: string; purpose: string };
      return p.purpose === 'stepup' && p.sub === actor.userId && p.sid === actor.sessionId;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- demo OTP signup / login

  normalizePhone(raw: string): string {
    return normalizePhone(raw);
  }

  async requestDemoOtp(rawPhone: string, ip: string) {
    if (!(await this.config.get('demo.enabled'))) throw new AppError('NOT_ENABLED', 'Demo accounts are currently unavailable.');
    const phone = this.normalizePhone(rawPhone);
    const since = new Date(Date.now() - 10 * 60_000);
    const [{ c }] = await this.dbs.db
      .select({ c: sql<number>`count(*)::int` })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phoneIndex(phone)), eq(otpChallenges.purpose, 'demo'), gt(otpChallenges.createdAt, since)));
    if (c >= OTP_MAX_PER_WINDOW) throw new AppError('RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes.');
    const code = numericCode(6);
    await this.dbs.db.insert(otpChallenges).values({
      phone: phoneIndex(phone),
      purpose: 'demo',
      codeHash: peppered(`${phone}:${code}`),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      requestIp: ip,
    });
    await this.sms.sendOtp(phone, code);
    await this.audit.recordStandalone({ action: 'auth.otp_requested', outcome: 'SUCCESS', ip, metadata: { phone: maskPhone(phone) } });
    return { sentTo: maskPhone(phone), resendAfterSec: 30, devCode: this.sms.isDev ? code : null };
  }

  async verifyDemoOtp(rawPhone: string, code: string, meta: ClientMeta) {
    const phone = this.normalizePhone(rawPhone);
    if (!/^\d{6}$/.test(code)) throw badInput('Enter the 6-digit OTP.');
    return this.dbs.serializable(async (tx) => {
      const [ch] = await tx
        .select()
        .from(otpChallenges)
        .where(and(eq(otpChallenges.phone, phoneIndex(phone)), eq(otpChallenges.purpose, 'demo'), isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, new Date())))
        .orderBy(desc(otpChallenges.createdAt))
        .limit(1)
        .for('update');
      if (!ch || ch.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('UNAUTHENTICATED', 'OTP expired. Please request a new one.');
      if (!safeEqualHex(ch.codeHash, peppered(`${phone}:${code}`))) {
        await tx.update(otpChallenges).set({ attempts: ch.attempts + 1 }).where(eq(otpChallenges.id, ch.id));
        return { error: 'Incorrect OTP.' } as const;
      }
      await tx.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, ch.id));

      let [u] = await tx.select().from(users).where(eq(users.phoneHash, phoneIndex(phone)));
      if (u && !u.isDemo) throw new AppError('UNAUTHENTICATED', 'This number belongs to a full account. Please sign in with your username.');
      if (!u) {
        let username = '';
        for (let i = 0; i < 5 && !username; i++) {
          const cand = `demo${numericCode(5)}`;
          const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.username, cand));
          if (!taken) username = cand;
        }
        if (!username) throw new AppError('CONFLICT', 'Please try again.');
        [u] = await tx
          .insert(users)
          .values({ username, displayName: username, ...phoneColumns(phone), role: 'TRADER', status: 'ACTIVE', mode: 'SIMULATED', isDemo: true, signupSource: 'demo' })
          .returning();
        const opening = BigInt(await this.config.get('demo.initialBalanceMinor'));
        if (opening > 0n) {
          const cash = await this.ledger.cashAccount(tx, u.id, 'SIMULATED');
          const fund = await this.ledger.systemAccount(tx, 'FUNDING_SOURCE', 'SIMULATED');
          await this.ledger.post(tx, {
            idempotencyKey: `opening:${u.id}`,
            kind: 'OPENING_BALANCE',
            mode: 'SIMULATED',
            memo: 'Virtual opening balance (demo — no cash value)',
            postings: [
              { accountId: cash, amountMinor: opening },
              { accountId: fund, amountMinor: -opening },
            ],
            refType: 'user',
            refId: u.id,
          });
        }
        await this.audit.record(tx, { actor: { userId: u.id, role: 'TRADER' }, action: 'user.demo_created', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip: meta.ip, metadata: { phone: maskPhone(phone) } });
      }
      if (u.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED', 'This account is not active.');
      return { user: u } as const;
    }).then(async (r) => {
      if ('error' in r) throw new AppError('UNAUTHENTICATED', r.error as string);
      return { ...(await this.admitSession(r.user, meta, { mfaVerified: false, method: 'otp' })), user: r.user };
    });
  }

  // ---------------------------------------------------------------- OTP helpers (signup, password reset)

  private async issueOtp(phone: string, purpose: 'signup' | 'reset', ip: string) {
    const since = new Date(Date.now() - 10 * 60_000);
    const [{ c }] = await this.dbs.db
      .select({ c: sql<number>`count(*)::int` })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phoneIndex(phone)), eq(otpChallenges.purpose, purpose), gt(otpChallenges.createdAt, since)));
    if (c >= OTP_MAX_PER_WINDOW) throw new AppError('RATE_LIMITED', 'Too many OTP requests. Please wait a few minutes.');
    const code = numericCode(6);
    await this.dbs.db.insert(otpChallenges).values({ phone: phoneIndex(phone), purpose, codeHash: peppered(`${purpose}:${phone}:${code}`), expiresAt: new Date(Date.now() + OTP_TTL_MS), requestIp: ip });
    await this.sms.sendOtp(phone, code);
    return code;
  }

  /** Returns true and consumes the challenge when the code matches; counts a failed attempt otherwise. */
  private async consumeOtp(tx: Tx, phone: string, purpose: 'signup' | 'reset', code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const [ch] = await tx
      .select()
      .from(otpChallenges)
      .where(and(eq(otpChallenges.phone, phoneIndex(phone)), eq(otpChallenges.purpose, purpose), isNull(otpChallenges.consumedAt), gt(otpChallenges.expiresAt, new Date())))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1)
      .for('update');
    if (!ch || ch.attempts >= OTP_MAX_ATTEMPTS) return false;
    if (!safeEqualHex(ch.codeHash, peppered(`${purpose}:${phone}:${code}`))) {
      await tx.update(otpChallenges).set({ attempts: ch.attempts + 1 }).where(eq(otpChallenges.id, ch.id));
      return false;
    }
    await tx.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, ch.id));
    return true;
  }

  // ---------------------------------------------------------------- self sign-up (approved by a Super Admin)

  async requestSignupOtp(rawPhone: string, ip: string) {
    if (!(await this.config.get('signup.enabled'))) throw new AppError('NOT_ENABLED', 'New accounts are not being accepted right now.');
    const phone = this.normalizePhone(rawPhone);
    const code = await this.issueOtp(phone, 'signup', ip);
    await this.audit.recordStandalone({ action: 'auth.signup_otp_requested', outcome: 'SUCCESS', ip, metadata: { phone: maskPhone(phone) } });
    return { sentTo: maskPhone(phone), resendAfterSec: 30, devCode: this.sms.isDev ? code : null };
  }

  /**
   * Creates a PENDING trader account after the mobile number is verified by OTP.
   * The account can't sign in until a Super Admin approves it (no balance is credited here).
   */
  async registerTrader(input: { displayName: string; username: string; phone: string; email?: string; password: string; code: string }, ip: string) {
    if (!(await this.config.get('signup.enabled'))) throw new AppError('NOT_ENABLED', 'New accounts are not being accepted right now.');
    const phone = this.normalizePhone(input.phone);
    const username = input.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw badInput('Username: 4–40 characters, starting with a letter; letters, digits, _ and . only.');
    const displayName = input.displayName.trim().replace(/\s+/g, ' ');
    if (displayName.length < 2 || displayName.length > 120) throw badInput('Enter your full name.');
    const email = input.email?.trim() ? normalizeEmail(input.email) : null;
    this.passwords.assertStrong(input.password, username);
    const hash = await this.passwords.hash(input.password);
    const r = await this.dbs.serializable(async (tx) => {
      if (!(await this.consumeOtp(tx, phone, 'signup', input.code))) return { error: 'Incorrect or expired OTP.' } as const;
      const [clash] = await tx
        .select({ username: users.username, phoneHash: users.phoneHash, emailHash: users.emailHash })
        .from(users)
        .where(or(eq(users.username, username), eq(users.phoneHash, phoneIndex(phone)), email ? eq(users.emailHash, emailIndex(email)) : undefined));
      // The caller has just proved they own this phone, so telling them it's registered is safe.
      if (clash?.phoneHash === phoneIndex(phone)) return { error: 'This mobile number already has an account. Sign in, or use Forgot password.' } as const;
      if (clash?.username === username) return { error: 'That username is taken. Please choose another.' } as const;
      if (clash) return { error: 'That email is already in use.' } as const;
      const [u] = await tx
        .insert(users)
        .values({ username, displayName, ...phoneColumns(phone), ...emailColumns(email), passwordHash: hash, passwordChangedAt: new Date(), role: 'TRADER', status: 'PENDING', mode: 'SIMULATED', signupSource: 'self_signup' })
        .returning();
      await this.ledger.cashAccount(tx, u.id, 'SIMULATED');
      await this.audit.record(tx, { actor: { userId: u.id, role: 'TRADER' }, action: 'user.self_registered', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip, metadata: { username, phone: maskPhone(phone) } });
      const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE')));
      for (const a of admins) await this.notifications.notify(tx, a.id, 'account.pending', 'New account request', `${displayName} (${username}) signed up and is waiting for approval.`);
      return { user: u } as const;
    });
    if ('error' in r) throw badInput(r.error as string);
    return { username: r.user.username, status: r.user.status };
  }

  // ---------------------------------------------------------------- forgot password (OTP to the registered mobile)

  /**
   * Always answers the same way, whether or not the account exists, so it can't be used to
   * discover usernames. Super Admin passwords can't be reset this way (another admin must do it).
   */
  async requestPasswordReset(rawUsername: string, ip: string) {
    const username = rawUsername.trim().toLowerCase().slice(0, 40);
    const [u] = await this.dbs.db.select().from(users).where(eq(users.username, username)).limit(1);
    let devCode: string | null = null;
    const phone = u ? readPhone(u) : null;
    const eligible = u && phone && u.status === 'ACTIVE' && u.role !== 'SUPER_ADMIN' && !u.isDemo;
    if (eligible) {
      requestContext.setActor({ userId: u.id, role: u.role });
      const code = await this.issueOtp(phone!, 'reset', ip);
      devCode = this.sms.isDev ? code : null;
    }
    await this.audit.recordStandalone({
      actor: u ? { userId: u.id, role: u.role } : undefined,
      action: 'auth.password_reset_requested',
      outcome: eligible ? 'SUCCESS' : 'DENIED',
      ip,
      metadata: eligible ? { phone: maskPhone(phone!) } : { reason: !u ? 'unknown_user' : u.role === 'SUPER_ADMIN' ? 'admin' : !phone ? 'no_phone' : 'inactive' },
    });
    return { message: 'If this account can be reset, we have sent a 6-digit code to its registered mobile number.', resendAfterSec: 30, devCode };
  }

  async resetPassword(rawUsername: string, code: string, newPassword: string, ip: string) {
    const username = rawUsername.trim().toLowerCase().slice(0, 40);
    const [u] = await this.dbs.db.select().from(users).where(eq(users.username, username)).limit(1);
    const generic = new AppError('UNAUTHENTICATED', 'Incorrect or expired code.');
    const phone = u ? readPhone(u) : null;
    if (!u || !phone || u.status !== 'ACTIVE' || u.role === 'SUPER_ADMIN' || u.isDemo) throw generic;
    requestContext.setActor({ userId: u.id, role: u.role });
    this.passwords.assertStrong(newPassword, u.username);
    const hash = await this.passwords.hash(newPassword);
    const ok = await this.dbs.serializable(async (tx) => {
      if (!(await this.consumeOtp(tx, phone, 'reset', code))) return false;
      await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, u.id));
      await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'password_reset' }).where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
      await this.audit.record(tx, { actor: { userId: u.id, role: u.role }, action: 'auth.password_reset', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip });
      await this.notifications.notify(tx, u.id, 'security.password_reset', 'Password was reset', 'Your password was reset with a code sent to your mobile, and all devices were signed out. If this wasn’t you, contact support.');
      return true;
    });
    if (!ok) {
      await this.audit.recordStandalone({ actor: { userId: u.id, role: u.role }, action: 'auth.password_reset_failed', outcome: 'FAILURE', ip });
      throw generic;
    }
    return true;
  }

  // ---------------------------------------------------------------- account self-service

  async changePassword(actor: Actor, current: string, next: string, ip: string) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, actor.userId));
    if (u.passwordHash && !(await this.passwords.verify(u.passwordHash, current))) throw badInput('Current password is incorrect.');
    this.passwords.assertStrong(next, u.username);
    const hash = await this.passwords.hash(next);
    await this.dbs.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date() }).where(eq(users.id, u.id));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), revokedReason: REVOKE_REASON.passwordChanged })
        .where(and(eq(sessions.userId, u.id), ne(sessions.id, actor.sessionId), isNull(sessions.revokedAt)));
      await this.audit.record(tx, { actor, action: 'auth.password_changed', entityType: 'user', entityId: u.id, outcome: 'SUCCESS', ip });
    });
    return true;
  }

  listSessions(userId: string) {
    return this.dbs.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastUsedAt));
  }

  async revokeSession(actor: Actor, sessionId: string, ip: string) {
    const r = await this.revokeSessions(and(eq(sessions.id, sessionId), eq(sessions.userId, actor.userId)) as ReturnType<typeof eq>, sessionId === actor.sessionId ? REVOKE_REASON.logout : REVOKE_REASON.user);
    if (!r.length) throw notFound('Session');
    await this.audit.recordStandalone({ actor, action: 'auth.session_revoked', entityType: 'session', entityId: sessionId, outcome: 'SUCCESS', ip });
    return true;
  }

  async revokeOtherSessions(actor: Actor, ip: string) {
    const r = await this.revokeSessions(and(eq(sessions.userId, actor.userId), ne(sessions.id, actor.sessionId)) as ReturnType<typeof eq>, REVOKE_REASON.user);
    await this.audit.recordStandalone({ actor, action: 'auth.sessions_revoked_all', outcome: 'SUCCESS', ip, metadata: { count: r.length } });
    return r.length;
  }

  // ---------------------------------------------------------------- concurrent sessions

  /** Error for a request from a session that has ended, telling the device why. */
  endedError(reason?: string | null) {
    const m = signedOutMessage(reason);
    return new AppError('UNAUTHENTICATED', m.message, { reason: m.code });
  }

  /** Sessions currently signed in (not revoked, not expired, not idle past the role's limit). */
  async activeSessions(userId: string, pol: RolePolicy) {
    const idleCut = new Date(Date.now() - pol.idleMinutes * 60_000);
    return this.dbs.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()), gt(sessions.lastUsedAt, idleCut)))
      .orderBy(asc(sessions.lastUsedAt));
  }

  /** Revoke sessions and tell each signed-out device immediately (WebSocket), with the reason. */
  async revokeSessions(where: ReturnType<typeof eq>, reason: string, tx: Tx | DbService['db'] = this.dbs.db) {
    const r = await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(where, isNull(sessions.revokedAt)))
      .returning({ id: sessions.id, deviceName: sessions.deviceName, userAgent: sessions.userAgent, ip: sessions.ip });
    const m = signedOutMessage(reason);
    setImmediate(() => r.forEach((x) => void pubsub.publish(TOPIC.session(x.id), { sessionEvents: { type: 'SIGNED_OUT', reason: m.code, message: m.message, at: new Date() } })));
    return r;
  }

  /**
   * Sign-in gate for every login method. Enforces the role's concurrent-session policy:
   *  - under the limit → new session
   *  - at the limit:  ask → return a short-lived "force login" token and the devices already signed in
   *                   replace_oldest → sign the oldest device(s) out, then continue
   *                   block → refuse
   */
  async admitSession(u: UserRow, meta: ClientMeta, opts: { mfaVerified: boolean; method: 'password' | 'mfa' | 'otp' }, force = false) {
    const pol = policyFor(await this.config.get('security.sessionPolicy'), u.role);
    const active = await this.activeSessions(u.id, pol);
    const over = pol.maxConcurrent > 0 && active.length >= pol.maxConcurrent;
    const audit = { actor: { userId: u.id, role: u.role }, ip: meta.ip };
    let toRevoke: string[] = [];
    let reason: string = REVOKE_REASON.replaced;
    if (over && !force) {
      const devices = active.map((s) => ({ id: s.id, deviceName: s.deviceName, userAgent: s.userAgent, ip: s.ip, lastUsedAt: s.lastUsedAt, createdAt: s.createdAt }));
      if (pol.onLimit === 'block') {
        await this.audit.recordStandalone({ ...audit, action: 'auth.concurrent_login_blocked', outcome: 'DENIED', metadata: { active: active.length, limit: pol.maxConcurrent } });
        throw new AppError('FORBIDDEN', `You're already signed in on ${active.length === 1 ? 'another device' : `${active.length} devices`}. Sign out there first.`, { reason: 'CONCURRENT_LOGIN_BLOCKED' });
      }
      if (pol.onLimit === 'ask') {
        await this.audit.recordStandalone({ ...audit, action: 'auth.concurrent_login_detected', outcome: 'DENIED', metadata: { active: active.length, limit: pol.maxConcurrent, devices: devices.map((d) => ({ ip: d.ip, device: d.deviceName ?? d.userAgent?.slice(0, 60) })) } });
        const conflictToken = this.jwt.sign(
          { sub: u.id, purpose: 'force_login', mfa: opts.mfaVerified, method: opts.method, ua: peppered(meta.userAgent).slice(0, 16), n: randomToken(8) },
          { secret: env().JWT_STEPUP_SECRET, expiresIn: 120, algorithm: 'HS256', issuer: 'tradedesk' },
        );
        return { conflict: { conflictToken, limit: pol.maxConcurrent, sessions: devices } } as const;
      }
      toRevoke = active.slice(0, active.length - pol.maxConcurrent + 1).map((s) => s.id);
    }
    if (over && force) {
      toRevoke = active.map((s) => s.id); // "sign out the other device(s) and continue here"
      reason = REVOKE_REASON.forceLogin;
    }
    const tokens = await this.dbs.db.transaction(async (tx) => {
      const out = toRevoke.length ? await this.revokeSessions(inArray(sessions.id, toRevoke) as ReturnType<typeof eq>, reason, tx) : [];
      const t = await this.createSession(tx, u, meta, opts.mfaVerified);
      if (out.length) {
        await this.audit.record(tx, { ...audit, action: force ? 'auth.force_login' : 'auth.session_replaced', entityType: 'session', entityId: t.sessionId, outcome: 'SUCCESS', metadata: { signedOut: out.map((x) => ({ id: x.id, ip: x.ip, device: x.deviceName ?? x.userAgent?.slice(0, 60) })) } });
        await this.notifications.notify(tx, u.id, 'security.force_login', 'Signed in on a new device',
          `You signed in from ${meta.deviceName ?? meta.userAgent.slice(0, 60)} (IP ${meta.ip}), so ${out.length === 1 ? 'your other device was' : `${out.length} other devices were`} signed out. If this wasn't you, change your password now.`);
      }
      await this.audit.record(tx, { ...audit, action: 'auth.login', entityType: 'session', entityId: t.sessionId, outcome: 'SUCCESS', metadata: opts.method === 'otp' ? { via: 'otp' } : { mfa: opts.mfaVerified, ...(force ? { forced: true } : {}) } });
      return t;
    });
    return { tokens } as const;
  }

  /** "Sign out the other device and continue here" after a concurrent-login prompt. */
  async forceLogin(conflictToken: string, meta: ClientMeta) {
    let p: { sub: string; purpose: string; mfa: boolean; method: 'password' | 'mfa' | 'otp'; ua: string };
    try {
      p = this.jwt.verify(conflictToken, { secret: env().JWT_STEPUP_SECRET, algorithms: ['HS256'], issuer: 'tradedesk' });
    } catch {
      throw new AppError('UNAUTHENTICATED', 'This sign-in request expired. Please sign in again.');
    }
    if (p.purpose !== 'force_login' || p.ua !== peppered(meta.userAgent).slice(0, 16)) throw unauthenticated();
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, p.sub));
    if (!u || u.status !== 'ACTIVE') throw unauthenticated();
    requestContext.setActor({ userId: u.id, role: u.role });
    const r = await this.admitSession(u, meta, { mfaVerified: p.mfa, method: p.method }, true);
    return { ...r, user: u };
  }

  /** Super Admin: see and end any account's sessions. */
  listUserSessions(userId: string) {
    return this.dbs.db.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))).orderBy(desc(sessions.lastUsedAt));
  }
  async adminRevokeSessions(actor: Actor, userId: string, sessionId: string | undefined, ip: string) {
    const out = await this.revokeSessions((sessionId ? and(eq(sessions.userId, userId), eq(sessions.id, sessionId)) : eq(sessions.userId, userId)) as ReturnType<typeof eq>, REVOKE_REASON.admin);
    await this.audit.recordStandalone({ actor, action: 'auth.sessions_revoked_by_admin', entityType: 'user', entityId: userId, outcome: 'SUCCESS', ip, metadata: { count: out.length, sessionId } });
    if (out.length) await this.notifications.notify(this.dbs.db, userId, 'security.admin_signout', 'Signed out by an administrator', `${out.length === 1 ? 'A device was' : `${out.length} devices were`} signed out of your account by an administrator.`);
    return out.length;
  }

  async acceptTerms(actor: Actor, ip: string) {
    await this.dbs.db.update(users).set({ termsAcceptedAt: new Date() }).where(eq(users.id, actor.userId));
    await this.audit.recordStandalone({ actor, action: 'user.terms_accepted', outcome: 'SUCCESS', ip });
    return true;
  }
}
