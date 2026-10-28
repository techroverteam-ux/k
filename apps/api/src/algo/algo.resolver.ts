import { Args, Context, Field, Float, ID, InputType, Int, Mutation, ObjectType, Parent, Query, ResolveField, Resolver, registerEnumType } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor } from '../common/context';
import { badInput } from '../common/errors';
import { Instrument } from '../common/gql-types';
import { toInstrument } from '../common/mappers';
import { formatMoney, parseMoney } from '../common/money';
import { RX } from '../common/validation';
import type { StrategyEventRow, StrategyRow, StrategyRunRow } from '../db/schema';
import { AlgoRunnerService } from './algo-runner.service';
import { AlgoService, type StrategyInterval } from './algo.service';

export enum StrategyIntervalGql { M1 = 'M1', M5 = 'M5', M15 = 'M15', H1 = 'H1', D1 = 'D1' }
registerEnumType(StrategyIntervalGql, { name: 'StrategyInterval' });

@ObjectType({ description: 'An automated paper-trading strategy built with the rule builder.' })
export class Strategy {
  @Field(() => ID) id: string;
  @Field() name: string;
  @Field(() => ID) instrumentId: string;
  @Field(() => StrategyIntervalGql) interval: string;
  @Field({ description: 'Rule set as JSON (see algo/rules.ts).' }) rules: string;
  @Field(() => Int) quantity: number;
  @Field(() => Int) version: number;
  @Field({ description: 'DRAFT | RUNNING | STOPPED' }) status: string;
  @Field() maxDailyLoss: string;
  @Field(() => Int) maxOrdersPerDay: number;
  @Field(() => Int, { description: "The strategy's own open position (signed). 0 = flat." }) position: number;
  @Field({ nullable: true }) entryPrice?: string;
  @Field({ nullable: true }) entryAt?: Date;
  @Field({ nullable: true }) startedAt?: Date;
  @Field({ nullable: true }) stoppedAt?: Date;
  @Field({ nullable: true }) stopReason?: string;
  @Field() updatedAt: Date;
}

@ObjectType()
export class StrategyToday {
  @Field({ description: 'Realised P&L today (IST), after fees.' }) pnl: string;
  @Field(() => Int) orders: number;
}

@ObjectType({ description: 'A saved backtest. metrics / trades / equity are JSON; money values in paise.' })
export class StrategyRun {
  @Field(() => ID) id: string;
  @Field(() => Int) version: number;
  @Field(() => StrategyIntervalGql) interval: string;
  @Field() from: Date;
  @Field() to: Date;
  @Field(() => Int) quantity: number;
  @Field() metrics: string;
  @Field() trades: string;
  @Field() equity: string;
  @Field() createdAt: Date;
}

@ObjectType()
export class StrategyEvent {
  @Field(() => ID) id: string;
  @Field() at: Date;
  @Field({ description: 'STARTED | STOPPED | ENTRY | EXIT | BLOCKED | ERROR' }) kind: string;
  @Field() message: string;
  @Field(() => ID, { nullable: true }) orderId?: string;
  @Field({ nullable: true }) pnl?: string;
}

@InputType()
class SaveStrategyInput {
  @Field(() => ID, { nullable: true }) @IsOptional() @IsUUID('all') id?: string;
  @Field() @MinLength(1) @MaxLength(80) name: string;
  @Field(() => ID) @IsUUID('all', { message: 'Pick an instrument.' }) instrumentId: string;
  @Field(() => StrategyIntervalGql) @IsEnum(StrategyIntervalGql) interval: StrategyIntervalGql;
  @Field({ description: 'Rule set as JSON.' }) @MaxLength(5000) rules: string;
  @Field(() => Int) @IsInt() @Min(1) @Max(100000) quantity: number;
  @Field({ description: 'Decimal rupees.' }) @Matches(RX.money, { message: 'Enter the max daily loss in rupees.' }) maxDailyLoss: string;
  @Field(() => Int) @IsInt() @Min(1) @Max(500) maxOrdersPerDay: number;
}

const toStrategy = (s: StrategyRow): Strategy => ({
  id: s.id,
  name: s.name,
  instrumentId: s.instrumentId,
  interval: s.interval,
  rules: JSON.stringify(s.rules),
  quantity: s.quantity,
  version: s.version,
  status: s.status,
  maxDailyLoss: formatMoney(s.maxDailyLossMinor),
  maxOrdersPerDay: s.maxOrdersPerDay,
  position: s.posQty,
  entryPrice: s.entryPriceMinor === null ? undefined : formatMoney(s.entryPriceMinor),
  entryAt: s.entryAt ?? undefined,
  startedAt: s.startedAt ?? undefined,
  stoppedAt: s.stoppedAt ?? undefined,
  stopReason: s.stopReason ?? undefined,
  updatedAt: s.updatedAt,
});
const toRun = (r: StrategyRunRow): StrategyRun => ({
  id: r.id, version: r.version, interval: r.interval, from: r.fromAt, to: r.toAt, quantity: r.quantity,
  metrics: JSON.stringify(r.metrics), trades: JSON.stringify(r.trades), equity: JSON.stringify(r.equity), createdAt: r.createdAt,
});
const toEvent = (e: StrategyEventRow): StrategyEvent => ({
  id: String(e.id), at: e.at, kind: e.kind, message: e.message, orderId: e.orderId ?? undefined, pnl: e.pnlMinor === null ? undefined : formatMoney(e.pnlMinor),
});

@Resolver(() => Strategy)
export class AlgoResolver {
  constructor(private readonly algo: AlgoService, private readonly runner: AlgoRunnerService) {}

  @Query(() => [Strategy], { description: 'Your automated strategies.' })
  async strategies(@CurrentActor() a: Actor) {
    return (await this.algo.list(a)).map(toStrategy);
  }

  @Query(() => Strategy)
  async strategy(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string) {
    return toStrategy(await this.algo.owned(a, id));
  }

  @Query(() => [StrategyRun])
  async strategyRuns(@CurrentActor() a: Actor, @Args('strategyId', { type: () => ID }) id: string, @Args('limit', { type: () => Int, nullable: true }) limit?: number) {
    return (await this.algo.runs(a, id, Math.min(Math.max(limit ?? 10, 1), 20))).map(toRun);
  }

  @Query(() => [StrategyEvent])
  async strategyEvents(@CurrentActor() a: Actor, @Args('strategyId', { type: () => ID }) id: string, @Args('limit', { type: () => Int, nullable: true }) limit?: number) {
    return (await this.algo.events(a, id, Math.min(Math.max(limit ?? 50, 1), 200))).map(toEvent);
  }

  @Mutation(() => Strategy, { description: 'Create or update a strategy (only while it is not running). Editing bumps its version.' })
  async saveStrategy(@CurrentActor() a: Actor, @Args('input') input: SaveStrategyInput, @Ctx() c: GqlContext) {
    let rules: unknown;
    try {
      rules = JSON.parse(input.rules);
    } catch {
      throw badInput('The rules are not valid JSON.');
    }
    let maxLoss: bigint;
    try {
      maxLoss = parseMoney(input.maxDailyLoss);
    } catch {
      throw badInput('Enter the max daily loss in rupees.');
    }
    return toStrategy(await this.algo.save(a, { id: input.id, name: input.name, instrumentId: input.instrumentId, interval: input.interval as StrategyInterval, rules, quantity: input.quantity, maxDailyLossMinor: maxLoss, maxOrdersPerDay: input.maxOrdersPerDay }, c.ip));
  }

  @Mutation(() => Boolean)
  deleteStrategy(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return this.algo.remove(a, id, c.ip);
  }

  @Mutation(() => StrategyRun, { description: 'Backtest the saved rules on stored candles for the last `days` days.' })
  async backtestStrategy(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('days', { type: () => Float }) days: number) {
    return toRun(await this.algo.runBacktest(a, id, days));
  }

  @Mutation(() => Strategy, { description: 'Start running the strategy on the simulated feed. Requires the trading rules accepted for this session.' })
  async startStrategy(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toStrategy(await this.algo.start(a, id, c.ip));
  }

  @Mutation(() => Strategy, { description: 'Stop the strategy. With flatten (default), its open position is closed at market.' })
  async stopStrategy(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('flatten', { type: () => Boolean, nullable: true }) flatten: boolean, @Ctx() c: GqlContext) {
    return toStrategy(await this.runner.stopByOwner(a, id, flatten ?? true, c.ip));
  }

  @Mutation(() => Int, { description: 'Kill switch: stop all of your running strategies and close their positions. Returns how many were stopped.' })
  stopAllStrategies(@CurrentActor() a: Actor, @Ctx() c: GqlContext) {
    return this.runner.stopAllForOwner(a, c.ip);
  }

  @ResolveField(() => Instrument, { nullable: true })
  async instrument(@Parent() s: Strategy, @Context() c: GqlContext) {
    const i = await c.loaders.instrument.load(s.instrumentId);
    return i ? toInstrument(i) : null;
  }

  @ResolveField(() => StrategyToday)
  async today(@Parent() s: Strategy) {
    const t = (await this.algo.today([s.id])).get(s.id)!;
    return { pnl: formatMoney(t.pnl), orders: t.orders };
  }
}
