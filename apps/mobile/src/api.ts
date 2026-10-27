import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createClient, type Client } from 'graphql-ws';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
if (!__DEV__ && !API_URL.startsWith('https://')) {
  throw new Error('Production builds must use an https:// API URL.');
}

const RT_KEY = 'td.refresh';
/** Web preview only: SecureStore isn't available in browsers, so keep the refresh token in memory (no persistence). */
const memStore = new Map<string, string>();
const store = Platform.OS === 'web'
  ? { getItemAsync: async (k: string) => memStore.get(k) ?? null, setItemAsync: async (k: string, v: string, _o?: unknown) => void memStore.set(k, v), deleteItemAsync: async (k: string) => void memStore.delete(k) }
  : SecureStore;

export class ApiError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

/**
 * Access token: memory only. Refresh token: device keychain/keystore via SecureStore
 * (hardware-backed where available), never AsyncStorage.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let stepUpHandler: (() => Promise<string | null>) | null = null;
let signedOutHandler: (() => void) | null = null;

export const setStepUpHandler = (h: typeof stepUpHandler) => (stepUpHandler = h);
export const setSignedOutHandler = (h: typeof signedOutHandler) => (signedOutHandler = h);
export const getAccessToken = () => accessToken;

export async function storeSession(access: string, refresh?: string | null) {
  accessToken = access;
  if (refresh) await store.setItemAsync(RT_KEY, refresh, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  resetWs();
}

export async function clearSession() {
  accessToken = null;
  await store.deleteItemAsync(RT_KEY).catch(() => undefined);
  resetWs();
}

async function raw(query: string, variables?: Record<string, unknown>, stepUp?: string) {
  const res = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-client': 'mobile',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(stepUp ? { 'x-step-up': stepUp } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const rt = await store.getItemAsync(RT_KEY);
      if (!rt) return false;
      const r = await raw(`mutation($r:String){ refresh(refreshToken:$r){ accessToken refreshToken } }`, { r: rt });
      const d = r.data?.refresh;
      if (!d?.accessToken) {
        await clearSession();
        return false;
      }
      await storeSession(d.accessToken, d.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function gql<T = any>(query: string, variables?: Record<string, unknown>, opts: { stepUp?: string; retried?: boolean } = {}): Promise<T> {
  let r;
  try {
    r = await raw(query, variables, opts.stepUp);
  } catch {
    throw new ApiError('Network error. Check your connection.', 'NETWORK');
  }
  const e = r.errors?.[0];
  if (!e) return r.data as T;
  const code = e.extensions?.code ?? 'ERROR';
  if (code === 'UNAUTHENTICATED' && accessToken && !opts.retried) {
    if (await refreshSession()) return gql<T>(query, variables, { ...opts, retried: true });
    await clearSession();
    signedOutHandler?.();
  }
  if (code === 'STEP_UP_REQUIRED' && stepUpHandler && !opts.stepUp) {
    const t = await stepUpHandler();
    if (t) return gql<T>(query, variables, { ...opts, stepUp: t });
    throw new ApiError('Verification cancelled.', 'CANCELLED');
  }
  throw new ApiError(e.message, code);
}

let ws: Client | null = null;
type LiveState = 'idle' | 'live' | 'reconnecting';
let liveState: LiveState = 'idle';
const liveListeners = new Set<(s: LiveState) => void>();
const setLive = (s: LiveState) => { if (s !== liveState) { liveState = s; liveListeners.forEach((l) => l(s)); } };
/** Live-price connection status, for the "reconnecting" banner. */
export function onLiveState(fn: (s: LiveState) => void) { liveListeners.add(fn); fn(liveState); return () => void liveListeners.delete(fn); }
function resetWs() {
  ws?.dispose();
  ws = null;
}
export function subscribe<T>(query: string, variables: Record<string, unknown>, onData: (d: T) => void) {
  ws ??= createClient({
    url: `${API_URL.replace(/^http/, 'ws')}/graphql`,
    connectionParams: () => ({ authorization: accessToken ? `Bearer ${accessToken}` : '' }),
    retryAttempts: Infinity,
    shouldRetry: () => true,
    lazy: true,
    on: {
      connected: () => setLive('live'),
      closed: (e) => setLive((e as { code?: number })?.code === 1000 || liveState === 'idle' ? 'idle' : 'reconnecting'),
      connecting: () => { if (liveState === 'live') setLive('reconnecting'); },
    },
  });
  return ws.subscribe<T>({ query, variables }, { next: (v) => v.data && onData(v.data as T), error: () => undefined, complete: () => undefined });
}

/** Cryptographically random idempotency key. */
export const newKey = () => Crypto.randomUUID().replace(/-/g, '');
