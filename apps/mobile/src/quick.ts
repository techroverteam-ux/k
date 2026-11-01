/**
 * Quick unlock on this phone: MPIN and fingerprint/Face ID.
 *
 * Set up once after signing in and verifying a one-time code. After that the app opens locked: the MPIN
 * (checked by the server, 5 tries) or the fingerprint key (kept by the phone behind its biometric check;
 * the server stores only a hash) opens a fresh session. Nothing here can open a session by itself.
 *
 * Stored in the keychain/keystore (never AsyncStorage):
 *  - the device id (not secret; useless without the MPIN or the key)
 *  - the fingerprint key, readable only after the phone's own biometric prompt
 *  - who this phone belongs to, for the lock screen greeting
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const DEVICE_KEY = 'td.qu.device';
const BIO_KEY = 'td.qu.bio';
const OWNER_KEY = 'td.qu.owner';
const SKIP_KEY = 'td.qu.skip';

/** How long the app may sit in the background before it locks again. */
export const RELOCK_AFTER_MS = 5 * 60_000;

export interface QuickOwner { userId: string; username: string; displayName: string; biometric: boolean }

const web = Platform.OS === 'web';
const mem = new Map<string, string>(); // web preview only: no keychain, nothing persists across reloads
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const get = (k: string) => (web ? Promise.resolve(mem.get(k) ?? null) : SecureStore.getItemAsync(k, opts));
const set = (k: string, v: string) => (web ? Promise.resolve(void mem.set(k, v)) : SecureStore.setItemAsync(k, v, opts));
const del = (k: string) => (web ? Promise.resolve(void mem.delete(k)) : SecureStore.deleteItemAsync(k, opts).catch(() => undefined));

export async function quickDevice(): Promise<{ deviceId: string; owner: QuickOwner } | null> {
  try {
    const [id, o] = await Promise.all([get(DEVICE_KEY), get(OWNER_KEY)]);
    return id && o ? { deviceId: id, owner: JSON.parse(o) as QuickOwner } : null;
  } catch {
    return null;
  }
}

export interface Biometry { available: boolean; label: string }
/** Whether this phone has a fingerprint or face enrolled, and what to call it. */
export async function biometry(): Promise<Biometry> {
  if (web) return { available: false, label: 'Fingerprint' };
  try {
    const [hw, enrolled, types] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync(), LocalAuthentication.supportedAuthenticationTypesAsync()]);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const label = face ? (Platform.OS === 'ios' ? 'Face ID' : 'Face unlock') : Platform.OS === 'ios' ? 'Touch ID' : 'Fingerprint';
    return { available: hw && enrolled, label };
  } catch {
    return { available: false, label: 'Fingerprint' };
  }
}

export async function saveQuickDevice(deviceId: string, owner: QuickOwner, bioKey?: string | null) {
  await set(DEVICE_KEY, deviceId);
  await del(BIO_KEY);
  if (bioKey && !web) {
    try {
      // Hardware-gated: the OS shows its biometric prompt before handing the key back.
      await SecureStore.setItemAsync(BIO_KEY, bioKey, { ...opts, requireAuthentication: true, authenticationPrompt: 'Turn on fingerprint unlock' });
    } catch {
      owner = { ...owner, biometric: false };
    }
  }
  await set(OWNER_KEY, JSON.stringify({ ...owner, biometric: !!bioKey && owner.biometric }));
  await del(SKIP_KEY);
}

/**
 * Ask for the fingerprint/face and return the key. null = cancelled or failed. 'gone' = the key no longer
 * exists or was invalidated (e.g. a new fingerprint was added to the phone), so fall back to the MPIN.
 */
export async function readBioKey(prompt: string): Promise<string | null | 'gone' | 'locked'> {
  if (web) return 'gone';
  try {
    const v = await SecureStore.getItemAsync(BIO_KEY, { ...opts, requireAuthentication: true, authenticationPrompt: prompt });
    return v ?? 'gone';
  } catch (e) {
    const m = String((e as Error)?.message ?? '');
    if (/cancel/i.test(m)) return null;
    if (/lock|too many|attempts/i.test(m)) return 'locked'; // the phone's own lockout; temporary
    return 'gone';
  }
}

export async function forgetBiometric() {
  await del(BIO_KEY);
  const q = await quickDevice();
  if (q) await set(OWNER_KEY, JSON.stringify({ ...q.owner, biometric: false }));
}

/** Remove quick unlock from this phone (the server side is revoked separately when we can). */
export async function forgetQuickDevice() {
  await Promise.all([del(DEVICE_KEY), del(BIO_KEY), del(OWNER_KEY)]);
}

/** "Not now" on the set-up offer: don't ask again for this account on this phone. */
export const skipQuickSetup = (userId: string) => set(SKIP_KEY, userId);
export const skippedQuickSetup = async (userId: string) => (await get(SKIP_KEY).catch(() => null)) === userId;
