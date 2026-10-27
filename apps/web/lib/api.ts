'use client';
import { createClient, type Client } from 'graphql-ws';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/**
 * Access token lives in memory only (never localStorage). The refresh token is an
 * httpOnly, SameSite=Strict cookie set by the API and is invisible to JavaScript.
 */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let stepUpHandler: (() => Promise<string | null>) | null = null;
let onSignedOut: (() => void) | null = null;

export const tokenStore = {
  set(t: string | null) {
    accessToken = t;
  },
  get: () => accessToken,
};
export function setStepUpHandler(h: typeof stepUpHandler) {
  stepUpHandler = h;
}
export function setSignedOutHandler(h: typeof onSignedOut) {
  onSignedOut = h;
}

/** Why the last session ended (shown on the sign-in screen), e.g. "signed in on another device". */
const SIGNED_OUT_KEY = 'td.signedOutReason';
export function rememberSignedOut(message: string) {
  try { sessionStorage.setItem(SIGNED_OUT_KEY, message); } catch { /* ignore */ }
}
export function takeSignedOutReason(): string | null {
  try { const m = sessionStorage.getItem(SIGNED_OUT_KEY); sessionStorage.removeItem(SIGNED_OUT_KEY); return m; } catch { return null; }
}

async function raw<T>(query: string, variables: Record<string, unknown> | undefined, stepUp?: string): Promise<{ data?: T; errors?: { message: string; extensions?: { code?: string } }[] }> {
  // Same-origin relay (app/graphql/route.ts) so the refresh cookie is first-party.
  const res = await fetch('/graphql', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'x-client': 'web',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(stepUp ? { 'x-step-up': stepUp } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status >= 500 && !res.headers.get('content-type')?.includes('json')) throw new ApiError('The server is unavailable. Try again shortly.', 'NETWORK');
  return res.json();
}

export async function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await raw<{ refresh: { accessToken: string } }>(`mutation { refresh { accessToken } }`, undefined);
      tokenStore.set(r.data?.refresh?.accessToken ?? null);
      const why = r.errors?.[0] as { message: string; extensions?: { reason?: string } } | undefined;
      if (why?.extensions?.reason && why.extensions.reason !== 'SESSION_ENDED') rememberSignedOut(why.message);
      return !!r.data?.refresh?.accessToken;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

/**
 * GraphQL request with: silent token refresh on UNAUTHENTICATED, and an interactive
 * step-up prompt (re-enter password / authenticator code) on STEP_UP_REQUIRED.
 */
export async function gql<T = any>(query: string, variables?: Record<string, unknown>, opts: { stepUp?: string; _retried?: boolean } = {}): Promise<T> {
  let r;
  try {
    r = await raw<T>(query, variables, opts.stepUp);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('Network error. Check your connection.', 'NETWORK');
  }
  const err = r.errors?.[0];
  if (!err) return r.data as T;
  const code = err.extensions?.code ?? 'ERROR';
  if (code === 'UNAUTHENTICATED' && !opts._retried && accessToken) {
    const reason = (err.extensions as { reason?: string } | undefined)?.reason;
    if (reason && reason !== 'SESSION_ENDED') rememberSignedOut(err.message); // e.g. signed in on another device
    else if (await refreshSession()) return gql<T>(query, variables, { ...opts, _retried: true });
    tokenStore.set(null);
    onSignedOut?.();
  }
  if (code === 'STEP_UP_REQUIRED' && stepUpHandler && !opts.stepUp) {
    const token = await stepUpHandler();
    if (token) return gql<T>(query, variables, { ...opts, stepUp: token });
    throw new ApiError('Verification cancelled.', 'CANCELLED');
  }
  throw new ApiError(err.message, code);
}

let ws: Client | null = null;
type LiveState = 'idle' | 'live' | 'reconnecting';
let liveState: LiveState = 'idle';
const liveListeners = new Set<(s: LiveState) => void>();
const setLive = (s: LiveState) => {
  if (s === liveState) return;
  liveState = s;
  liveListeners.forEach((l) => l(s));
};
/** Real-time feed connection status, for the "reconnecting" banner. */
export function onLiveState(fn: (s: LiveState) => void) {
  liveListeners.add(fn);
  fn(liveState);
  return () => void liveListeners.delete(fn);
}
export function wsClient() {
  ws ??= createClient({
    url: `${API_URL.replace(/^http/, 'ws')}/graphql`,
    connectionParams: () => ({ authorization: accessToken ? `Bearer ${accessToken}` : '' }),
    retryAttempts: Infinity,
    shouldRetry: () => true,
    lazy: true,
    on: {
      connected: () => setLive('live'),
      closed: (e) => setLive((e as { code?: number })?.code === 1000 || liveState === 'idle' ? 'idle' : 'reconnecting'),
      connecting: () => liveState === 'live' && setLive('reconnecting'),
    },
  });
  return ws;
}
export function resetWs() {
  ws?.dispose();
  ws = null;
}

export function subscribe<T>(query: string, variables: Record<string, unknown>, onData: (d: T) => void) {
  return wsClient().subscribe<T>({ query, variables }, { next: (v) => v.data && onData(v.data as T), error: () => undefined, complete: () => undefined });
}

export const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
