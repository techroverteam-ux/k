import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';
import { IsISO8601, IsOptional, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

@InputType()
export class PaymentEvidenceInput {
  @Field(() => ID) @IsUUID('all') payeeAccountId: string;
  @Field()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Za-z0-9]{6,30}$/, { message: 'Enter a UTR / payment reference of 6–30 letters and digits.' })
  utr: string;
  @Field() @Length(2, 120) payerName: string;
  @Field() @IsISO8601({ strict: true }) paidAt: string;
  @Field({ nullable: true }) @IsOptional() @MaxLength(800_000) proof?: string;
}

@ObjectType()
export class PaymentEvidence {
  @Field(() => ID) id: string;
  @Field(() => ID) userId: string;
  @Field(() => ID, { nullable: true }) paymentRequestId?: string;
  @Field(() => ID) payeeAccountId: string;
  @Field() payee: string;
  @Field() accountName: string;
  @Field({ nullable: true }) bankName?: string;
  @Field({ nullable: true }) accountNumber?: string;
  @Field({ nullable: true }) ifsc?: string;
  @Field({ nullable: true }) branch?: string;
  @Field({ nullable: true }) upiId?: string;
  @Field() amount: string;
  @Field() utr: string;
  @Field() payerName: string;
  @Field() paidAt: Date;
  @Field() hasProof: boolean;
  @Field() createdAt: Date;
}
