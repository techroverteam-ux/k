import type { UserRow } from '../db/schema';
import { blindIndex, decryptField, encryptField } from './crypto';
import { badInput } from './errors';

/**
 * Personal data at rest. Phone numbers and emails are stored only as AES-256-GCM ciphertext plus a
 * keyed blind index (HMAC) used for lookups and uniqueness. Decrypt only where the value is needed.
 */
export function normalizePhone(raw: string): string {
  // Strip the country code only when it's actually there (a 10-digit number may itself start with 91).
  const d = raw.replace(/[\s-]/g, '').replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  if (!/^[6-9]\d{9}$/.test(d)) throw badInput('Enter a valid 10-digit Indian mobile number.');
  return `+91${d}`;
}
export function normalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw badInput('Enter a valid email address.');
  return e;
}

export const phoneIndex = (normalized: string) => blindIndex(normalized, 'phone');
export const emailIndex = (normalized: string) => blindIndex(normalized, 'email');

/** Column values for a (normalised) phone / email. */
export function phoneColumns(normalized: string | null | undefined) {
  return normalized ? { phoneEnc: encryptField(normalized, 'users.phone'), phoneHash: phoneIndex(normalized) } : { phoneEnc: null, phoneHash: null };
}
export function emailColumns(normalized: string | null | undefined) {
  return normalized ? { emailEnc: encryptField(normalized, 'users.email'), emailHash: emailIndex(normalized) } : { emailEnc: null, emailHash: null };
}

export function readPhone(u: Pick<UserRow, 'phoneEnc' | 'legacyPhone'>): string | null {
  return u.phoneEnc ? decryptField(u.phoneEnc, 'users.phone') : u.legacyPhone ?? null;
}
export function readEmail(u: Pick<UserRow, 'emailEnc' | 'legacyEmail'>): string | null {
  return u.emailEnc ? decryptField(u.emailEnc, 'users.email') : u.legacyEmail ?? null;
}
