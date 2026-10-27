import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { env } from '../config/env';

/** HMAC-SHA256 with a server-side pepper. Used for refresh tokens and OTPs (high-entropy or short-lived). */
export function peppered(value: string): string {
  return createHmac('sha256', env().HASH_PEPPER).update(value).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function numericCode(digits = 6): string {
  return randomInt(0, 10 ** digits)
    .toString()
    .padStart(digits, '0');
}

/** AES-256-GCM envelope: base64(iv | tag | ciphertext). Key comes from env/KMS, never from the DB. */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(env().DATA_ENCRYPTION_KEY, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(blob: string): string {
  const key = Buffer.from(env().DATA_ENCRYPTION_KEY, 'base64');
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
