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
  @Field(() => AccountModeGql) mode: AccountModeGql;
  @Field() isDemo: boolean;
  @Field(() => ID, { nullable: true }) brokerId?: string;
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
      mode: u.mode as AccountModeGql,
      isDemo: u.isDemo,
      brokerId: u.brokerId ?? undefined,
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
