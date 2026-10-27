import { Args, Field, ID, InputType, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { inArray } from 'drizzle-orm';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, RequireStepUp, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { PaymentRequest, PaymentStatusGql, PaymentTypeGql } from '../common/gql-types';
import { clampLimit, toPayment } from '../common/mappers';
import { parseMoney } from '../common/money';
import { DbService } from '../db/db';
import { users } from '../db/schema';
import { PaymentsService } from './payments.service';

@InputType()
class PaymentRequestInput {
  @Field(() => PaymentTypeGql) type: PaymentTypeGql;
  @Field({ description: 'Decimal rupees, e.g. "10000.00"' }) amount: string;
  @Field({ description: 'Client-generated unique key; retries are safe.' }) idempotencyKey: string;
  @Field(() => ID, { nullable: true, description: 'Broker/admin: the trader this request is for.' }) userId?: string;
  @Field({ nullable: true }) note?: string;
}

@Resolver()
export class PaymentsResolver {
  constructor(
    private readonly payments: PaymentsService,
    private readonly dbs: DbService,
  ) {}

  private async withNames(rows: Awaited<ReturnType<PaymentsService['list']>>) {
    const ids = [...new Set(rows.map((r) => r.userId))];
    const names = ids.length ? await this.dbs.db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids)) : [];
    const map = new Map(names.map((n) => [n.id, n.username]));
    return rows.map((r) => toPayment(r, map.get(r.userId)));
  }

  @Mutation(() => PaymentRequest)
  async requestPayment(@CurrentActor() a: Actor, @Args('input') input: PaymentRequestInput, @Ctx() c: GqlContext) {
    let amount: bigint;
    try {
      amount = parseMoney(input.amount);
    } catch {
      throw badInput('Enter a valid amount (up to 2 decimals).');
    }
    return toPayment(await this.payments.request(a, { ...input, amountMinor: amount }, c.ip));
  }

  @Query(() => [PaymentRequest])
  async paymentRequests(
    @CurrentActor() a: Actor,
    @Args('status', { type: () => [PaymentStatusGql], nullable: true }) status?: PaymentStatusGql[],
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ) {
    return this.withNames(await this.payments.list(a, { status: status as any, userId, limit: clampLimit(limit) }));
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => PaymentRequest, { description: 'Checker approval. Posts to the ledger atomically. Requester cannot approve.' })
  async approvePayment(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('note', { nullable: true }) note: string, @Ctx() c: GqlContext) {
    return toPayment(await this.payments.approve(a, id, note, c.ip));
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => PaymentRequest)
  async rejectPayment(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('note') note: string, @Ctx() c: GqlContext) {
    return toPayment(await this.payments.reject(a, id, note, c.ip));
  }

  @Mutation(() => PaymentRequest)
  async cancelPayment(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPayment(await this.payments.cancel(a, id, c.ip));
  }
}
