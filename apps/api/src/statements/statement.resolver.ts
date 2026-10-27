import { Args, Field, ID, Int, Mutation, ObjectType, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, lim } from '../common/context';
import { StatementService } from './statement.service';

@ObjectType()
class StatementLink {
  @Field({ description: 'Path on the API host, e.g. /statement.pdf?token=…; valid for expiresIn seconds.' }) path: string;
  @Field(() => Int) expiresIn: number;
  @Field() fileName: string;
}

@Resolver()
export class StatementResolver {
  constructor(private readonly statements: StatementService) {}

  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => StatementLink, { description: 'Bill / account statement PDF for a date range (IST, inclusive). Returns a 2-minute download link.' })
  statementLink(
    @CurrentActor() a: Actor,
    @Args('from', { description: 'YYYY-MM-DD' }) from: string,
    @Args('to', { description: 'YYYY-MM-DD' }) to: string,
    @Ctx() c: GqlContext,
    @Args('userId', { type: () => ID, nullable: true }) userId?: string,
  ) {
    return this.statements.createLink(a, userId ?? a.userId, from, to, c.ip);
  }
}
