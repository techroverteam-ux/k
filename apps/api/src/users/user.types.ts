import { formatMoney } from '../common/money';
import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { UserRow } from '../db/schema';
import { maskPhone } from '../auth/sms.provider';
import { readEmail, readPhone } from '../common/pii';

export enum RoleGql {
  SUPER_ADMIN = 'SUPER_ADMIN',
  BROKER = 'BROKER',
  TRADER = 'TRADER',
}
export enum UserStatusGql {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  CLOSED = 'CLOSED',
  REJECTED = 'REJECTED',
}
export enum AccountModeGql {
  SIMULATED = 'SIMULATED',
  LIVE = 'LIVE',
}
registerEnumType(RoleGql, { name: 'Role' });
registerEnumType(UserStatusGql, { name: 'UserStatus' });
registerEnumType(AccountModeGql, { name: 'AccountMode', description: 'SIMULATED = paper trading with virtual money.' });

@ObjectType('User')
export class UserType {
  @Field(() => ID) id: string;
  @Field() username: string;
  @Field() displayName: string;
  @Field({ nullable: true, description: 'Masked unless you are the owner or a Super Admin.' }) phone?: string;
  @Field({ nullable: true }) email?: string;
  @Field(() => RoleGql) role: RoleGql;
  @Field(() => UserStatusGql) status: UserStatusGql;
  @Field({ nullable: true }) rejectionReason?: string;
  @Field(() => AccountModeGql) mode: AccountModeGql;
  @Field() isDemo: boolean;
  @Field(() => ID, { nullable: true }) brokerId?: string;
  @Field({ nullable: true, description: 'Brokers: commission share in percent (e.g. "40.00"); empty = platform default. Shown to Super Admins and the broker.' }) commissionPct?: string;
  @Field({ nullable: true, description: "Brokers: earning per mini lot in rupees (per side), their own or the platform default." }) commissionPerMiniLot?: string;
  @Field({ nullable: true, description: 'Brokers: earning per mega lot in rupees (per side).' }) commissionPerMegaLot?: string;
  @Field({ nullable: true, description: 'Brokers: true when the platform default per-lot amounts apply.' }) commissionIsDefault?: boolean;
  @Field({ nullable: true, description: "Traders: their broker's name." }) brokerName?: string;
  @Field({ nullable: true, description: 'Who asked for this account (Super Admins only).' }) createdByName?: string;
  @Field({ nullable: true, description: 'Traders: opening amount asked for at creation (rupees, e.g. "50000.00"); credited when the account is approved. Shown to Super Admins, the trader\'s broker and the trader.' }) openingAmount?: string;
  @Field({ nullable: true }) resetDisabledAt?: Date;
  @Field() mfaEnabled: boolean;
  @Field() termsAccepted: boolean;
  @Field() createdAt: Date;

  static from(u: UserRow, viewer?: { userId: string; role: string }): UserType {
    const full = viewer && (viewer.userId === u.id || viewer.role === 'SUPER_ADMIN');
    const phone = u.phoneEnc || u.legacyPhone ? readPhone(u) : null; // decrypt only when present
    return Object.assign(new UserType(), {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      phone: phone ? (full ? phone : maskPhone(phone)) : undefined,
      email: full ? (readEmail(u) ?? undefined) : undefined,
      role: u.role as RoleGql,
      status: u.status as UserStatusGql,
      rejectionReason: u.rejectionReason ?? undefined,
      mode: u.mode as AccountModeGql,
      isDemo: u.isDemo,
      brokerId: u.brokerId ?? undefined,
      commissionPct: full && u.role === 'BROKER' && u.commissionShareBps !== null ? (u.commissionShareBps / 100).toFixed(2) : undefined,
      openingAmount: u.openingAmountMinor && viewer && (full || u.brokerId === viewer.userId) ? formatMoney(u.openingAmountMinor) : undefined,
      resetDisabledAt: u.resetDisabledAt ?? undefined,
      mfaEnabled: u.mfaEnabled,
      termsAccepted: !!u.termsAcceptedAt,
      createdAt: u.createdAt,
    });
  }
}

@ObjectType()
export class UserPage {
  @Field(() => [UserType]) items: UserType[];
  @Field(() => Int) total: number;
}
