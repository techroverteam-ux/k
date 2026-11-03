import { Args, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, lim, RequireStepUp, Roles } from '../common/context';
import { formatMoney } from '../common/money';
import { WipeService } from './wipe.service';

@ObjectType()
class WipePreview {
  @Field({ description: 'Balance now.' }) balance: string;
  @Field({ description: 'Balance after the wipe (the opening balance).' }) resetTo: string;
  @Field(() => Int) openPositions: number;
  @Field(() => Int) openOrders: number;
  @Field(() => Int) runningStrategies: number;
  @Field(() => Int) pendingRequests: number;
  @Field({ description: 'How the wipe is confirmed: TOTP (authenticator app), SMS or PASSWORD.' }) method: string;
}

@ObjectType()
class WipeChallenge {
  @Field() method: string;
  @Field({ nullable: true }) sentTo?: string;
  @Field(() => Int) resendAfterSec: number;
  @Field({ nullable: true, description: 'Development only. Always null in production.' }) devCode?: string;
}

@ObjectType()
class WipeResult {
  @Field(() => ID) wipeId: string;
  @Field() balance: string;
}

@ObjectType()
class AccountWipe {
  @Field(() => ID) id: string;
  @Field(() => ID) byId: string;
  @Field() verifiedWith: string;
  @Field() balanceBefore: string;
  @Field() balanceAfter: string;
  @Field({ description: 'JSON: positions, watchlist and the orders, strategies and requests the wipe cancelled.' }) snapshot: string;
  @Field({ nullable: true }) ip?: string;
  @Field() createdAt: Date;
}

@ObjectType()
class PlatformWipe {
  @Field(() => ID) id: string;
  @Field() status: string;
  @Field(() => ID) requestedById: string;
  @Field() reason: string;
  @Field(() => ID, { nullable: true }) decidedById?: string;
  @Field({ nullable: true }) decidedAt?: Date;
  @Field() expiresAt: Date;
  @Field({ nullable: true, description: 'JSON counts of what was deleted.' }) summary?: string;
  @Field() createdAt: Date;
  @Field(() => ID, { nullable: true, description: 'Set for a single-account delete.' }) targetUserId?: string;
  @Field({ nullable: true }) targetUsername?: string;
  @Field({ nullable: true }) targetRole?: string;
}

type WipeRow = { id: string; status: string; requestedById: string; reason: string; decidedById: string | null; decidedAt: Date | null; expiresAt: Date; summary: unknown; createdAt: Date; targetUserId: string | null; targetUsername: string | null; targetRole: string | null };
const toPlatform = (r: WipeRow): PlatformWipe => ({
  ...r, decidedById: r.decidedById ?? undefined, decidedAt: r.decidedAt ?? undefined, summary: r.summary ? JSON.stringify(r.summary) : undefined,
  targetUserId: r.targetUserId ?? undefined, targetUsername: r.targetUsername ?? undefined, targetRole: r.targetRole ?? undefined,
});

@Resolver()
export class WipeResolver {
  constructor(private readonly wipe: WipeService) {}

  // ---- a trader or broker wiping their own account
  @Roles('TRADER', 'BROKER')
  @Query(() => WipePreview, { description: 'What “wipe out” would do to my account.' })
  wipePreview(@CurrentActor() a: Actor) {
    return this.wipe.preview(a);
  }

  @Roles('TRADER', 'BROKER')
  @Throttle({ default: { limit: lim(5), ttl: 60_000 } })
  @Mutation(() => WipeChallenge, { description: 'Step 1: sends an SMS code, or asks for the authenticator code / password.' })
  async beginAccountWipe(@CurrentActor() a: Actor, @Ctx() c: GqlContext) {
    const r = await this.wipe.begin(a, c.ip);
    return { ...r, sentTo: r.sentTo ?? undefined, devCode: r.devCode ?? undefined };
  }

  @Roles('TRADER', 'BROKER')
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => WipeResult, { description: 'Step 2: the code from step 1 and confirm = "WIPE". Fresh start; Super Admin keeps the history.' })
  wipeMyAccount(@CurrentActor() a: Actor, @Args('code') code: string, @Args('confirm') confirm: string, @Ctx() c: GqlContext) {
    return this.wipe.wipeSelf(a, code, confirm, c.ip);
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [AccountWipe], { description: 'Wipes of one account, with what each one cleared.' })
  async accountWipes(@Args('userId', { type: () => ID }) userId: string): Promise<AccountWipe[]> {
    const rows = await this.wipe.listForUser(userId);
    return rows.map((r) => ({ id: r.id, byId: r.byId, verifiedWith: r.verifiedWith, balanceBefore: formatMoney(r.balanceBeforeMinor), balanceAfter: formatMoney(r.balanceAfterMinor), snapshot: JSON.stringify(r.snapshot), ip: r.ip ?? undefined, createdAt: r.createdAt }));
  }

  // ---- Super Admin: wipe all trading data (maker-checker)
  @Roles('SUPER_ADMIN')
  @Query(() => [PlatformWipe])
  async platformWipes() {
    return (await this.wipe.listPlatform()).map(toPlatform);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => PlatformWipe, { description: 'Ask to permanently delete every trader and broker account and all trading data. Another Super Admin must approve within 30 minutes. confirm = "WIPE ALL DATA".' })
  async requestPlatformWipe(@CurrentActor() a: Actor, @Args('reason') reason: string, @Args('confirm') confirm: string, @Ctx() c: GqlContext) {
    return toPlatform(await this.wipe.requestPlatform(a, reason, confirm, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => String, { description: 'A different Super Admin approves and runs the wipe. Returns JSON counts. confirm = "WIPE ALL DATA".' })
  async approvePlatformWipe(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('confirm') confirm: string, @Ctx() c: GqlContext) {
    return JSON.stringify(await this.wipe.approvePlatform(a, id, confirm, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => PlatformWipe, { description: 'Reject (or, for the requester, cancel) a pending wipe.' })
  async rejectPlatformWipe(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPlatform(await this.wipe.rejectPlatform(a, id, c.ip));
  }

  // ---- Super Admin: delete one trader / broker account permanently (maker-checker)
  @Roles('SUPER_ADMIN')
  @Query(() => [PlatformWipe], { description: 'Delete requests for one account (userId) or all accounts.' })
  async userDeletions(@Args('userId', { type: () => ID, nullable: true }) userId?: string) {
    return (await this.wipe.listUserDeletions(userId)).map(toPlatform);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => PlatformWipe, { description: 'Ask to permanently delete one trader or broker and all their data. confirm = their username. Another Super Admin must approve within 30 minutes.' })
  async requestUserDeletion(@CurrentActor() a: Actor, @Args('userId', { type: () => ID }) userId: string, @Args('reason') reason: string, @Args('confirm') confirm: string, @Ctx() c: GqlContext) {
    return toPlatform(await this.wipe.requestUserDeletion(a, userId, reason, confirm, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => String, { description: 'A different Super Admin approves and the account is deleted. Returns JSON counts. confirm = the username.' })
  async approveUserDeletion(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('confirm') confirm: string, @Ctx() c: GqlContext) {
    return JSON.stringify(await this.wipe.approveUserDeletion(a, id, confirm, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => PlatformWipe, { description: 'Reject (or, for the requester, cancel) a pending delete.' })
  async rejectUserDeletion(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPlatform(await this.wipe.rejectUserDeletion(a, id, c.ip));
  }
}
