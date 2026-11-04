import { Args, Field, Float, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Actor } from '../common/context';
import { CurrentActor, Roles } from '../common/context';
import { formatMoney } from '../common/money';
import { PolicyService } from '../policy/policy.service';
import { RiskService } from './risk.service';

@ObjectType()
export class RiskStatus {
  @Field({ description: 'Funds put into the account (opening + deposits − withdrawals), rupees.' }) funds: string;
  @Field({ description: 'Loss so far (booked + open P&L + brokerage), rupees; 0 when in profit.' }) loss: string;
  @Field(() => Float, { description: 'Loss as % of funds.' }) lossPct: number;
  @Field({ description: 'OK, WARN (passed the warning level) or CUT (trades were cut automatically).' }) state: string;
  @Field(() => Int) warnPct: number;
  @Field(() => Int) cutPct: number;
  @Field(() => Int) openPositions: number;
}

@Resolver()
export class RiskResolver {
  constructor(private readonly risk: RiskService, private readonly policy: PolicyService) {}

  @Roles('TRADER', 'BROKER', 'SUPER_ADMIN')
  @Query(() => RiskStatus, { description: 'Loss watch: traders see their own; brokers their traders; Super Admins anyone.' })
  async riskStatus(@CurrentActor() a: Actor, @Args('userId', { type: () => ID, nullable: true }) userId?: string): Promise<RiskStatus> {
    const id = userId ?? a.userId;
    if (id !== a.userId) await this.policy.assertCanAccessUser(a, id, '');
    const v = await this.risk.forUser(id);
    return { funds: formatMoney(v.fundsMinor), loss: formatMoney(v.lossMinor > 0n ? v.lossMinor : 0n), lossPct: v.lossPct, state: v.state, warnPct: v.warnPct, cutPct: v.cutPct, openPositions: v.openPositions };
  }
}
