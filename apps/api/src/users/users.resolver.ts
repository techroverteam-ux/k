import { IsEmail, IsEnum, IsOptional, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { RX } from '../common/validation';
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
import { Args, Field, ID, InputType, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, RequireStepUp, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { AdminOverview, CommissionReport } from '../common/gql-types';
import { clampLimit } from '../common/mappers';
import { formatMoney } from '../common/money';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { RoleGql, UserPage, UserStatusGql, UserType } from './user.types';
import { UsersService } from './users.service';

@InputType()
class CreateUserInput {
  @Field() @Transform(trimLower) @Matches(RX.username, { message: 'Username: 4–40 characters, start with a letter; letters, digits, _ and . only.' }) username: string;
  @Field() @Transform(trim) @Length(2, 120, { message: 'Enter a name of 2–120 characters.' }) displayName: string;
  @Field(() => RoleGql) @IsEnum(RoleGql) role: RoleGql;
  @Field({ nullable: true }) @IsOptional() @Matches(RX.phoneIn, { message: 'Enter a valid mobile number.' }) phone?: string;
  @Field({ nullable: true }) @IsOptional() @IsEmail({}, { message: 'Enter a valid email address.' }) @MaxLength(254) email?: string;
  @Field(() => ID, { nullable: true }) @IsOptional() @IsUUID('all', { message: 'Invalid broker.' }) brokerId?: string;
  @Field({ description: 'Temporary password; the user should change it on first sign-in.' }) @Length(10, 128, { message: 'Password must be 10–128 characters.' }) tempPassword: string;
}

@Resolver()
export class UsersResolver {
  constructor(
    private readonly users: UsersService,
    private readonly recon: ReconciliationService,
  ) {}

  @Roles('SUPER_ADMIN', 'BROKER')
  @Query(() => UserPage, { name: 'users', description: 'Admins see everyone; brokers see only their assigned traders.' })
  async users_(
    @CurrentActor() a: Actor,
    @Args('role', { type: () => RoleGql, nullable: true }) role?: RoleGql,
    @Args('status', { type: () => UserStatusGql, nullable: true }) status?: UserStatusGql,
    @Args('search', { nullable: true }) search?: string,
    @Args('brokerId', { type: () => ID, nullable: true }) brokerId?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<UserPage> {
    const r = await this.users.list(a, { role, status, search, brokerId, limit: clampLimit(limit), offset: Math.max(0, Math.min(offset ?? 0, 100_000)) });
    return { items: r.items.map((u) => UserType.from(u, a)), total: r.total };
  }

  @Roles('SUPER_ADMIN', 'BROKER')
  @Query(() => UserType)
  async user(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return UserType.from(await this.users.get(a, id, c.ip), a);
  }

  @Roles('SUPER_ADMIN', 'BROKER')
  @Mutation(() => UserType, { description: 'Creates a PENDING account. A different Super Admin must approve it.' })
  async createUser(@CurrentActor() a: Actor, @Args('input') input: CreateUserInput, @Ctx() c: GqlContext) {
    return UserType.from(await this.users.create(a, input, c.ip), a);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => UserType)
  async approveUser(@CurrentActor() a: Actor, @Args('userId', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return UserType.from(await this.users.approve(a, id, c.ip), a);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => UserType)
  async setUserStatus(
    @CurrentActor() a: Actor,
    @Args('userId', { type: () => ID }) id: string,
    @Args('status', { type: () => UserStatusGql }) status: UserStatusGql,
    @Args('reason') reason: string,
    @Ctx() c: GqlContext,
  ) {
    if (status === 'PENDING') throw badInput('Invalid status.');
    return UserType.from(await this.users.setStatus(a, id, status as 'ACTIVE' | 'SUSPENDED' | 'CLOSED', reason, c.ip), a);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => UserType)
  async assignTraderToBroker(
    @CurrentActor() a: Actor,
    @Args('traderId', { type: () => ID }) traderId: string,
    @Args('brokerId', { type: () => ID, nullable: true }) brokerId: string | null,
    @Ctx() c: GqlContext,
  ) {
    return UserType.from(await this.users.assignBroker(a, traderId, brokerId ?? null, c.ip), a);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => Boolean)
  resetUserPassword(@CurrentActor() a: Actor, @Args('userId', { type: () => ID }) id: string, @Args('tempPassword') pw: string, @Ctx() c: GqlContext) {
    return this.users.adminResetPassword(a, id, pw, c.ip);
  }

  @Roles('SUPER_ADMIN')
  @Query(() => AdminOverview)
  async adminOverview(): Promise<AdminOverview> {
    const o = await this.users.adminOverview();
    const [last] = await this.recon.latest(1);
    return {
      ...o,
      pendingPaymentsAmount: formatMoney(o.pendingPaymentsMinor),
      lastReconciliation: last ? { id: last.id, ok: last.ok, summaryJson: JSON.stringify(last.summary), createdAt: last.createdAt } : undefined,
    };
  }

  @Roles('SUPER_ADMIN', 'BROKER')
  @Query(() => CommissionReport)
  async commissionReport(
    @CurrentActor() a: Actor,
    @Args('from') from: Date,
    @Args('to') to: Date,
    @Args('brokerId', { type: () => ID, nullable: true }) brokerId?: string,
  ): Promise<CommissionReport> {
    const r = await this.users.brokerCommission(a, brokerId ?? a.userId, from, to);
    return {
      shareBps: r.shareBps,
      lines: r.lines.map((l) => ({ userId: l.userId, username: l.username, brokerage: formatMoney(l.brokerageMinor), commission: formatMoney(l.commissionMinor) })),
      total: formatMoney(r.totalMinor),
    };
  }
}
