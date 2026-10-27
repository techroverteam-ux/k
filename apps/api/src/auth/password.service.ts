import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { badInput } from '../common/errors';

// OWASP Password Storage Cheat Sheet: argon2id, m=19 MiB, t=2, p=1 (minimum). We use a bit more memory.
const OPTS = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 3, parallelism: 1 } as const;
const COMMON = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'letmein123']);

@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;

  hash(plain: string) {
    return argon2.hash(plain, OPTS);
  }

  async verify(hash: string | null | undefined, plain: string): Promise<boolean> {
    // Always do the work so response time does not reveal whether the account exists.
    if (!hash) {
      this.dummy ??= argon2.hash('dummy-password-for-timing', OPTS);
      await argon2.verify(await this.dummy, plain).catch(() => false);
      return false;
    }
    return argon2.verify(hash, plain).catch(() => false);
  }

  assertStrong(plain: string, username?: string) {
    if (plain.length < 10) throw badInput('Password must be at least 10 characters.');
    if (plain.length > 128) throw badInput('Password is too long.');
    if (COMMON.has(plain.toLowerCase())) throw badInput('That password is too common.');
    if (username && plain.toLowerCase().includes(username.toLowerCase())) throw badInput('Password must not contain your username.');
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(plain)).length;
    if (classes < 3) throw badInput('Use at least three of: lowercase, uppercase, digits, symbols.');
  }
}
