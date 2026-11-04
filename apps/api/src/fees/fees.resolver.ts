import { Args, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { soleAdminMayApprove } from '../common/maker-checker';
import { DbService } from '../db/db';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, Length, MaxLength } from 'class-validator';
import type { Actor, GqlContext } from '../common/context';
import { Ctx, CurrentActor, lim, RequireStepUp, Roles } from '../common/context';
import { badInput } from '../common/errors';
import { formatMoney, parseMoney } from '../common/money';
import { FeesService } from './fees.service';

@ObjectType()
class PayeeAccount {
  @Field(() => ID) id: string;
  @Field({ description: 'BANK or UPI' }) kind: string;
  @Field() label: string;
  @Field() accountName: string;
  @Field({ nullable: true }) bankName?: string;
  @Field({ nullable: true }) accountNumber?: string;
  @Field({ nullable: true }) ifsc?: string;
  @Field({ nullable: true }) branch?: string;
  @Field({ nullable: true }) upiId?: string;
  @Field({ description: 'PENDING (waiting for a second Super Admin), ACTIVE, REJECTED, DISABLED' }) status: string;
  @Field(() => ID) createdById: string;
  @Field() createdAt: Date;
}

@InputType()
class PayeeAccountInput {
  @Field() @IsIn(['BANK', 'UPI']) kind: 'BANK' | 'UPI';
  @Field() @Length(2, 80) label: string;
  @Field() @Length(2, 120) accountName: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(120) bankName?: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(24) accountNumber?: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(11) ifsc?: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(120) branch?: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(120) upiId?: string;
}

@ObjectType()
class FeePayment {
  @Field(() => ID) id: string;
  @Field(() => ID) userId: string;
  @Field() username: string;
  @Field() displayName: string;
  @Field() payee: string;
  @Field() amount: string;
  @Field() purpose: string;
  @Field() utr: string;
  @Field({ description: 'True when a payment screenshot is attached (fetch it with feePaymentProof).' }) hasProof: boolean;
  @Field({ description: 'SUBMITTED, VERIFIED or REJECTED' }) status: string;
  @Field({ nullable: true }) reviewNote?: string;
  @Field({ nullable: true }) reviewedAt?: Date;
  @Field() createdAt: Date;
}

type PayeeRow = Awaited<ReturnType<FeesService['listPayees']>>[number];
const toPayee = (p: PayeeRow): PayeeAccount => ({
  id: p.id, kind: p.kind, label: p.label, accountName: p.accountName, bankName: p.bankName ?? undefined, accountNumber: p.accountNumber ?? undefined,
  ifsc: p.ifsc ?? undefined, branch: p.branch ?? undefined, upiId: p.upiId ?? undefined, status: p.status, createdById: p.createdById, createdAt: p.createdAt,
});

@Resolver()
export class FeesResolver {
  constructor(private readonly fees: FeesService, private readonly dbs: DbService) {}

  @Query(() => [PayeeAccount], { description: 'Where to pay fees. Traders and brokers see active ones; Super Admin sees all.' })
  async payeeAccounts(@CurrentActor() a: Actor) {
    return (await this.fees.listPayees(a)).map(toPayee);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => PayeeAccount, { description: 'Add a bank account or UPI ID. Traders see it only after a different Super Admin approves it.' })
  async addPayeeAccount(@CurrentActor() a: Actor, @Args('input') input: PayeeAccountInput, @Ctx() c: GqlContext) {
    const p = await this.fees.addPayee(a, input, c.ip);
    // Only one Super Admin (single-admin mode): live straight away.
    return toPayee(await soleAdminMayApprove(this.dbs.db) ? await this.fees.decidePayee(a, p.id, 'approve', c.ip) : p);
  }

  @Roles('SUPER_ADMIN')
  @RequireStepUp()
  @Mutation(() => PayeeAccount)
  async approvePayeeAccount(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPayee(await this.fees.decidePayee(a, id, 'approve', c.ip));
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => PayeeAccount)
  async rejectPayeeAccount(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPayee(await this.fees.decidePayee(a, id, 'reject', c.ip));
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => PayeeAccount, { description: 'Stop showing these details. To change details, disable and add new ones.' })
  async disablePayeeAccount(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return toPayee(await this.fees.decidePayee(a, id, 'disable', c.ip));
  }

  @Roles('TRADER', 'BROKER')
  @Throttle({ default: { limit: lim(10), ttl: 60_000 } })
  @Mutation(() => FeePayment, { description: 'Tell us about a fee you paid: amount, UTR / reference number and a screenshot of the payment (data URL, JPG/PNG/WebP, max 550 kB). A Super Admin verifies it. Send the request with the header x-upload: fee-proof.' })
  async submitFeePayment(
    @CurrentActor() a: Actor,
    @Args('payeeAccountId', { type: () => ID }) payeeAccountId: string,
    @Args('amount') amount: string,
    @Args('purpose') purpose: string,
    @Args('utr') utr: string,
    @Args('proof', { description: 'Screenshot of the payment as a data URL: data:image/jpeg;base64,…' }) proof: string,
    @Ctx() c: GqlContext,
  ) {
    let minor: bigint;
    try { minor = parseMoney(amount); } catch { throw badInput('Enter the amount you paid (up to 2 decimals).'); }
    if (purpose.length > 200 || utr.length > 60) throw badInput('Too long.');
    if (proof.length > 800_000) throw badInput('The screenshot is too large (max 550 kB).');
    const f = await this.fees.submit(a, { payeeAccountId, amountMinor: minor, purpose, utr, proof }, c.ip);
    const [row] = (await this.fees.list(a, undefined, 100)).filter((r) => r.f.id === f.id);
    return toFee(row);
  }

  @Query(() => [FeePayment], { description: 'Fee payments: your own (trader), your traders’ (broker), everyone’s (Super Admin).' })
  async feePayments(@CurrentActor() a: Actor, @Args('status', { type: () => [String], nullable: true }) status?: string[], @Args('limit', { type: () => Int, nullable: true }) limit?: number) {
    return (await this.fees.list(a, status, Math.min(Math.max(limit ?? 100, 1), 500))).map(toFee);
  }

  @Roles('TRADER', 'BROKER', 'SUPER_ADMIN')
  @Query(() => String, { description: 'The payment screenshot as a data URL: for the trader who paid, their broker and Super Admins.' })
  feePaymentProof(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Ctx() c: GqlContext) {
    return this.fees.proof(a, id, c.ip);
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => FeePayment)
  async reviewFeePayment(@CurrentActor() a: Actor, @Args('id', { type: () => ID }) id: string, @Args('verified') verified: boolean, @Args('note', { nullable: true }) note: string, @Ctx() c: GqlContext) {
    await this.fees.review(a, id, verified, note, c.ip);
    const [row] = (await this.fees.list(a, undefined, 500)).filter((r) => r.f.id === id);
    return toFee(row);
  }
}

type FeeRow = Awaited<ReturnType<FeesService['list']>>[number];
function toFee(r: FeeRow): FeePayment {
  return {
    id: r.f.id, userId: r.f.userId, username: r.username, displayName: r.displayName, payee: r.payee, amount: formatMoney(r.f.amountMinor), purpose: r.f.purpose,
    utr: r.f.utr, hasProof: r.proofBytes !== null, status: r.f.status, reviewNote: r.f.reviewNote ?? undefined, reviewedAt: r.f.reviewedAt ?? undefined, createdAt: r.f.createdAt,
  };
}
