import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'crypto';
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

/*
 * Field encryption (AES-256-GCM) with a key ring.
 *
 *   enc:v2:<keyId>:<base64url(iv[12] | tag[16] | ciphertext)>
 *
 * - Keys come from the environment / KMS (DATA_ENCRYPTION_KEY + DATA_ENCRYPTION_KEY_ID), never from the DB.
 * - Old keys stay readable through DATA_ENCRYPTION_KEYS_PREVIOUS ("k0:base64,k-1:base64") until
 *   `npm run keys:rotate` has re-encrypted everything with the current key.
 * - Each value is bound to its column with AAD (e.g. "users.phone"), so a ciphertext copied into a
 *   different column or row type fails to decrypt instead of being silently accepted.
 * - Values written before v2 (no prefix) are still readable with the current key.
 */
const PREFIX = 'enc:v2:';
type Ring = { currentId: string; keys: Map<string, Buffer> };
let ring: Ring | undefined;
function keyRing(): Ring {
  if (ring) return ring;
  const e = env();
  const keys = new Map<string, Buffer>();
  keys.set(e.DATA_ENCRYPTION_KEY_ID, Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64'));
  for (const part of (e.DATA_ENCRYPTION_KEYS_PREVIOUS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, b64] = part.split(':');
    const k = Buffer.from(b64 ?? '', 'base64');
    if (!id || k.length !== 32) throw new Error('DATA_ENCRYPTION_KEYS_PREVIOUS must be "id:base64(32 bytes)" entries');
    if (!keys.has(id)) keys.set(id, k);
  }
  ring = { currentId: e.DATA_ENCRYPTION_KEY_ID, keys };
  return ring;
}
/** For tests and key-rotation tooling. */
export function resetKeyRing() {
  ring = undefined;
  blindKey = undefined;
}

export function encryptField(plain: string, aad: string): string {
  const { currentId, keys } = keyRing();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keys.get(currentId)!, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${currentId}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function decryptField(blob: string, aad: string): string {
  const { keys } = keyRing();
  if (!blob.startsWith(PREFIX)) return decryptLegacy(blob, keys.get(keyRing().currentId)!);
  const rest = blob.slice(PREFIX.length);
  const sep = rest.indexOf(':');
  const id = rest.slice(0, sep);
  const key = keys.get(id);
  if (!key) throw new Error(`No decryption key for key id "${id}"`);
  const raw = Buffer.from(rest.slice(sep + 1), 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Which key encrypted this value (for rotation). Legacy values report "legacy". */
export function keyIdOf(blob: string): string {
  return blob.startsWith(PREFIX) ? blob.slice(PREFIX.length).split(':')[0] : 'legacy';
}
export const needsRotation = (blob: string) => keyIdOf(blob) !== keyRing().currentId;

function decryptLegacy(blob: string, key: Buffer): string {
  const raw = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Blind index: a keyed HMAC of the normalised value, so encrypted columns can still be looked up
 * and kept unique ("is this phone already registered?") without storing or decrypting the value.
 * Uses its own key (BLIND_INDEX_KEY, or one derived from HASH_PEPPER with HKDF).
 */
let blindKey: Buffer | undefined;
export function blindIndex(value: string, purpose: 'phone' | 'email'): string {
  blindKey ??= env().BLIND_INDEX_KEY
    ? Buffer.from(env().BLIND_INDEX_KEY!, 'base64')
    : Buffer.from(hkdfSync('sha256', Buffer.from(env().HASH_PEPPER, 'utf8'), Buffer.alloc(0), 'tradedesk/blind-index/v1', 32));
  return createHmac('sha256', blindKey).update(`${purpose}:${value}`).digest('hex');
}

/** MFA secrets: same envelope, bound to their column. */
export const encryptSecret = (plain: string) => encryptField(plain, 'users.mfa_secret');
export const decryptSecret = (blob: string) => decryptField(blob, 'users.mfa_secret');
