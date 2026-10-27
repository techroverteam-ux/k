import { Args, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import type { Actor, GqlContext } from '../common/context';
import { AllowWithoutMfa, Ctx, CurrentActor, lim, Public } from '../common/context';
import { unauthenticated } from '../common/errors';
import { env } from '../config/env';
import { DbService } from '../db/db';
import { users, type UserRow } from '../db/schema';
import { UserType } from '../users/user.types';
import { AuthService, type IssuedTokens } from './auth.service';

const RT_COOKIE = 'td_rt';

@ObjectType()
class AuthPayload {
  @Field({ nullable: true }) accessToken?: string;
  @Field(() => Int, { nullable: true }) expiresIn?: number;
  @Field({ nullable: true, description: 'Only returned to mobile clients (x-client: mobile). Web uses an httpOnly cookie.' })
  refreshToken?: string;
  @Field() mfaRequired: boolean;
  @Field({ nullable: true }) mfaToken?: string;
  @Field(() => UserType, { nullable: true }) user?: UserType;
}

@ObjectType()
class OtpRequestResult {
  @Field() sentTo: string;
  @Field(() => Int) resendAfterSec: number;
  @Field({ nullable: true, description: 'Development only. Always null in production.' }) devCode?: string;
}

@ObjectType()
class SignupResult {
  @Field() username: string;
  @Field({ description: 'PENDING until a Super Admin approves the account.' }) status: string;
}

@ObjectType()
class PasswordResetRequest {
  @Field() message: string;
  @Field(() => Int) resendAfterSec: number;
  @Field({ nullable: true, description: 'Development only. Always null in production.' }) devCode?: string;
}

@InputType()
class RegisterInput {
  @Field() displayName: string;
  @Field() username: string;
  @Field() phone: string;
  @Field({ nullable: true }) email?: string;
  @Field() password: string;
  @Field({ description: 'OTP sent by requestSignupOtp' }) code: string;
}

@ObjectType()
class MfaEnrollment {
  @Field() secret: string;
  @Field() otpauthUrl: string;
}

@ObjectType()
class StepUpToken {
  @Field() token: string;
  @Field(() => Int) expiresIn: number;
}

@ObjectType('Session')
class SessionType {
  @Field(() => ID) id: string;
  @Field({ nullable: true }) deviceName?: string;
  @Field({ nullable: true }) userAgent?: string;
  @Field({ nullable: true }) ip?: string;
  @Field() createdAt: Date;
  @Field() lastUsedAt: Date;
  @Field() current: boolean;
  @Field() mfaVerified: boolean;
}

@Resolver()
export class AuthResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly dbs: DbService,
  ) {}

  private meta(c: GqlContext, deviceName?: string) {
    return { ip: c.ip, userAgent: c.userAgent || 'unknown', deviceName };
  }

  private isMobile(c: GqlContext) {
    return c.req?.headers?.['x-client'] === 'mobile';
  }

  private deliver(c: GqlContext, t: IssuedTokens, u: UserRow): AuthPayload {
    const mobile = this.isMobile(c);
    if (!mobile && c.res) {
      c.res.cookie(RT_COOKIE, t.refreshToken, {
        httpOnly: true,
        secure: env().COOKIE_SECURE,
        sameSite: 'strict',
        path: '/graphql',
        maxAge: env().REFRESH_TOKEN_TTL_DAYS * 86_400_000,
      });
    }
    return {
      accessToken: t.accessToken,
      expiresIn: t.expiresIn,
      refreshToken: mobile ? t.refreshToken : undefined,
      mfaRequired: false,
      user: UserType.from(u, { userId: u.id, role: u.role }),
    };
  }

  @Public()
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => AuthPayload)
  async login(@Args('username') username: string, @Args('password') password: string, @Args('deviceName', { nullable: true }) deviceName: string, @Ctx() c: GqlContext) {
    if (username.length > 40 || password.length > 128) throw unauthenticated();
    const r = await this.auth.login(username, password, this.meta(c, deviceName));
    if (r.mfaRequired) return { mfaRequired: true, mfaToken: r.mfaToken };
    return this.deliver(c, r.tokens, r.user);
  }

  @Public()
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => AuthPayload)
  async completeMfaLogin(@Args('mfaToken') mfaToken: string, @Args('code') code: string, @Args('deviceName', { nullable: true }) deviceName: string, @Ctx() c: GqlContext) {
    const r = await this.auth.completeMfaLogin(mfaToken, code, this.meta(c, deviceName));
    return this.deliver(c, r.tokens, r.user);
  }

  @Public()
  @Throttle({ default: { limit: lim(30), ttl: 60_000 } })
  @Mutation(() => AuthPayload)
  async refresh(@Args('refreshToken', { nullable: true }) refreshToken: string, @Ctx() c: GqlContext) {
    const token = refreshToken ?? (c.req as any)?.cookies?.[RT_COOKIE];
    if (!token || typeof token !== 'string' || token.length > 200) throw unauthenticated();
    const t = await this.auth.refresh(token, this.meta(c));
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, (await this.auth.verifyAccess(t.accessToken)).userId));
    return this.deliver(c, t, u);
  }

  @Public()
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => OtpRequestResult)
  requestDemoOtp(@Args('phone') phone: string, @Ctx() c: GqlContext) {
    return this.auth.requestDemoOtp(phone, c.ip);
  }

  @Public()
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => AuthPayload)
  async verifyDemoOtp(@Args('phone') phone: string, @Args('code') code: string, @Args('deviceName', { nullable: true }) deviceName: string, @Ctx() c: GqlContext) {
    const r = await this.auth.verifyDemoOtp(phone, code, this.meta(c, deviceName));
    return this.deliver(c, r.tokens, r.user);
  }

  @Public()
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => OtpRequestResult, { description: 'Step 1 of sign-up: verify the mobile number.' })
  requestSignupOtp(@Args('phone') phone: string, @Ctx() c: GqlContext) {
    return this.auth.requestSignupOtp(phone, c.ip);
  }

  @Public()
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => SignupResult, { description: 'Step 2 of sign-up. The account stays PENDING until a Super Admin approves it.' })
  registerTrader(@Args('input') input: RegisterInput, @Ctx() c: GqlContext) {
    if (input.password.length > 128 || input.code.length > 10) throw unauthenticated();
    return this.auth.registerTrader(input, c.ip);
  }

  @Public()
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => PasswordResetRequest, { description: 'Sends a reset code to the registered mobile. Same answer whether or not the account exists.' })
  requestPasswordReset(@Args('username') username: string, @Ctx() c: GqlContext) {
    return this.auth.requestPasswordReset(username, c.ip);
  }

  @Public()
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => Boolean, { description: 'Sets a new password with the code; signs out every device.' })
  resetPassword(@Args('username') username: string, @Args('code') code: string, @Args('newPassword') newPassword: string, @Ctx() c: GqlContext) {
    if (newPassword.length > 128 || code.length > 10) throw unauthenticated();
    return this.auth.resetPassword(username, code, newPassword, c.ip);
  }

  @AllowWithoutMfa()
  @Mutation(() => Boolean)
  async logout(@CurrentActor() a: Actor, @Ctx() c: GqlContext) {
    await this.auth.revokeSession(a, a.sessionId, c.ip);
    c.res?.clearCookie(RT_COOKIE, { path: '/graphql' });
    return true;
  }

  @AllowWithoutMfa()
  @Query(() => UserType)
  async me(@CurrentActor() a: Actor) {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, a.userId));
    return UserType.from(u, a);
  }

  @AllowWithoutMfa()
  @Mutation(() => MfaEnrollment)
  beginMfaEnrollment(@CurrentActor() a: Actor) {
    return this.auth.beginMfaEnrollment(a);
  }

  @AllowWithoutMfa()
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => Boolean)
  confirmMfaEnrollment(@CurrentActor() a: Actor, @Args('code') code: string, @Ctx() c: GqlContext) {
    return this.auth.confirmMfaEnrollment(a, code, c.ip);
  }

  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => StepUpToken, { description: 'Re-verify identity before a sensitive action. Send the token as the x-step-up header.' })
  stepUp(@CurrentActor() a: Actor, @Args('password', { nullable: true }) password: string, @Args('totp', { nullable: true }) totp: string, @Ctx() c: GqlContext) {
    return this.auth.stepUp(a, { password, totp }, c.ip);
  }

  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => Boolean)
  changePassword(@CurrentActor() a: Actor, @Args('currentPassword') cur: string, @Args('newPassword') next: string, @Ctx() c: GqlContext) {
    return this.auth.changePassword(a, cur, next, c.ip);
  }

  @AllowWithoutMfa()
  @Mutation(() => Boolean)
  acceptTerms(@CurrentActor() a: Actor, @Ctx() c: GqlContext) {
    return this.auth.acceptTerms(a, c.ip);
  }

  @AllowWithoutMfa()
  @Query(() => [SessionType])
  async mySessions(@CurrentActor() a: Actor) {
    const rows = await this.auth.listSessions(a.userId);
    return rows.map((s) => ({ ...s, current: s.id === a.sessionId }));
  }

  @Mutation(() => Boolean)
  revokeSession(@CurrentActor() a: Actor, @Args('sessionId', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return this.auth.revokeSession(a, id, c.ip);
  }

  @Mutation(() => Int)
  revokeOtherSessions(@CurrentActor() a: Actor, @Ctx() c: GqlContext) {
    return this.auth.revokeOtherSessions(a, c.ip);
  }
}
