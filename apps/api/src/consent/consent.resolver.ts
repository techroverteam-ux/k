import { Args, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Actor, GqlContext } from '../common/context';
import { AllowWithoutMfa, Ctx, CurrentActor, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { clampLimit } from '../common/mappers';
import type { AuditEventRow, ConsentRow } from '../db/schema';
import { PolicyService } from '../policy/policy.service';
import { ConsentService } from './consent.service';

@ObjectType()
class ConsentStatus {
  @Field({ description: 'True when this session must accept the rules before trading.' }) required: boolean;
  @Field({ description: 'SHA-256 of the exact rules text; send it back when accepting.' }) termsVersion: string;
  @Field(() => [String]) rules: string[];
  @Field({ nullable: true }) acceptedAt?: Date;
}

@ObjectType()
class ConsentRecord {
  @Field(() => ID) id: string;
  @Field(() => ID) userId: string;
  @Field({ nullable: true }) username?: string;
  @Field({ nullable: true }) displayName?: string;
  @Field(() => ID) sessionId: string;
  @Field() termsVersion: string;
  @Field(() => [String]) rules: string[];
  @Field() acceptedAt: Date;
  @Field() ip: string;
  @Field({ nullable: true }) userAgent?: string;
  @Field({ nullable: true }) client?: string;
  @Field({ nullable: true }) requestId?: string;
}

@ObjectType()
class LoginEvent {
  @Field() seq: string;
  @Field() at: Date;
  @Field() action: string;
  @Field({ description: 'SUCCESS, FAILURE or DENIED' }) outcome: string;
  @Field(() => ID, { nullable: true }) userId?: string;
  @Field({ nullable: true }) username?: string;
  @Field({ nullable: true }) role?: string;
  @Field({ nullable: true }) ip?: string;
  @Field({ nullable: true }) userAgent?: string;
  @Field(() => ID, { nullable: true }) sessionId?: string;
  @Field({ nullable: true }) requestId?: string;
  @Field({ nullable: true, description: 'password, mfa, otp…; failure reason when known' }) detail?: string;
}

const toConsent = (c: ConsentRow, username?: string, displayName?: string): ConsentRecord => ({
  id: c.id, userId: c.userId, username, displayName, sessionId: c.sessionId, termsVersion: c.termsVersion, rules: c.termsText as string[], acceptedAt: c.acceptedAt,
  ip: c.ip, userAgent: c.userAgent ?? undefined, client: c.client ?? undefined, requestId: c.requestId ?? undefined,
});
const toLogin = (e: AuditEventRow, username?: string | null, role?: string | null): LoginEvent => {
  const m = (e.metadata ?? {}) as Record<string, unknown>;
  const detail = m.via ? String(m.via) : m.mfa === true ? 'password + 2-step code' : m.mfa === false ? 'password' : m.reason ? String(m.reason).replace(/_/g, ' ') : m.fails ? `failed attempts: ${m.fails}` : undefined;
  return { seq: e.seq.toString(), at: e.createdAt, action: e.action, outcome: e.outcome, userId: e.actorId ?? undefined, username: username ?? undefined, role: role ?? e.actorRole ?? undefined, ip: e.ip ?? undefined, userAgent: e.userAgent ?? undefined, sessionId: e.sessionId ?? undefined, requestId: e.requestId ?? undefined, detail };
};
const date = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw badInput('Invalid date.');
  return d;
};
const IP_RE = /^[0-9a-fA-F:.]{2,64}$/;

/** Trading consent (per session) and sign-in audit. */
@Resolver()
export class ConsentResolver {
  constructor(
    private readonly consent: ConsentService,
    private readonly policy: PolicyService,
  ) {}

  @AllowWithoutMfa()
  @Query(() => ConsentStatus)
  async tradingConsentStatus(@CurrentActor() a: Actor): Promise<ConsentStatus> {
    return this.consent.status(a);
  }

  @AllowWithoutMfa()
  @Mutation(() => ConsentRecord, { description: 'Accept the trading rules for this session. Stored with time, IP, device and the exact rules text.' })
  async acceptTradingConsent(@CurrentActor() a: Actor, @Args('termsVersion') v: string, @Ctx() c: GqlContext) {
    if (!/^[0-9a-f]{64}$/.test(v)) throw badInput('Invalid terms version.');
    return toConsent(await this.consent.accept(a, v, c.ip));
  }

  @AllowWithoutMfa()
  @Query(() => [ConsentRecord], { description: 'Consents for one account (yours by default). Super Admins can omit userId to see everyone.' })
  async consentLog(
    @CurrentActor() a: Actor,
    @Ctx() c: GqlContext,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('ip', { nullable: true }) ip?: string,
    @Args('from', { nullable: true }) from?: string,
    @Args('to', { nullable: true }) to?: string,
    @Args('before', { nullable: true }) before?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<ConsentRecord[]> {
    const target = userId ?? (a.role === 'SUPER_ADMIN' ? undefined : a.userId);
    if (target) await this.policy.assertCanAccessUser(a, target, c.ip);
    if (ip && !IP_RE.test(ip)) throw badInput('Invalid IP address.');
    const rows = await this.consent.listConsents({ userId: target, ip, from: date(from), to: date(to), beforeAt: date(before), limit: clampLimit(limit, 50, 500) });
    return rows.map((r) => toConsent(r.c, r.username, r.displayName));
  }

  @AllowWithoutMfa()
  @Query(() => [LoginEvent], { description: 'Sign-in history (successful and failed) for one account — yours by default.' })
  async loginHistory(
    @CurrentActor() a: Actor,
    @Ctx() c: GqlContext,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('beforeSeq', { nullable: true }) beforeSeq?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<LoginEvent[]> {
    const target = userId ?? a.userId;
    await this.policy.assertCanAccessUser(a, target, c.ip);
    if (beforeSeq && !/^\d{1,19}$/.test(beforeSeq)) throw badInput('Invalid cursor.');
    const rows = await this.consent.loginEvents({ userId: target, beforeSeq: beforeSeq ? BigInt(beforeSeq) : undefined, limit: clampLimit(limit, 50, 200) });
    return rows.map((r) => toLogin(r.e, r.username, r.role));
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [LoginEvent], { description: 'Platform-wide sign-in audit, including attempts on unknown usernames.' })
  async loginAudit(
    @Args('outcome', { nullable: true }) outcome?: string,
    @Args('ip', { nullable: true }) ip?: string,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('from', { nullable: true }) from?: string,
    @Args('to', { nullable: true }) to?: string,
    @Args('beforeSeq', { nullable: true }) beforeSeq?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<LoginEvent[]> {
    if (ip && !IP_RE.test(ip)) throw badInput('Invalid IP address.');
    if (beforeSeq && !/^\d{1,19}$/.test(beforeSeq)) throw badInput('Invalid cursor.');
    const rows = await this.consent.loginEvents({ userId, ip, outcome, from: date(from), to: date(to), beforeSeq: beforeSeq ? BigInt(beforeSeq) : undefined, limit: clampLimit(limit, 100, 500) });
    return rows.map((r) => toLogin(r.e, r.username, r.role));
  }
}
