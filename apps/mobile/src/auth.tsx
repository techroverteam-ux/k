import * as Device from 'expo-device';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { clearSession, gql, refreshSession, rememberSignedOut, setPersistRefresh, setSignedOutHandler, storeSession, subscribe } from './api';
import { forgetQuickDevice, quickDevice, RELOCK_AFTER_MS, type QuickOwner } from './quick';
import { requestSplash } from './splash';

export type Role = 'SUPER_ADMIN' | 'BROKER' | 'TRADER';
export interface Me { id: string; username: string; displayName: string; role: Role; isDemo: boolean; mfaEnabled: boolean; termsAccepted: boolean }
export interface Settings { appName: string; tickerMessages: string[]; termsRules: string[]; helplineUrl: string; demoEnabled: boolean; signupEnabled: boolean; maxWatchlists: number; minDeposit?: string; apiVersion: string }

export const DEVICE_NAME = `${Device.manufacturer ?? ''} ${Device.modelName ?? 'Mobile'}`.trim();

export interface QuickState { deviceId: string; owner: QuickOwner }
interface Ctx {
  me: Me | null; ready: boolean; settings: Settings | null;
  reload: () => Promise<Me | null>; signIn: (access: string, refresh?: string | null) => Promise<Me | null>; signOut: () => Promise<void>;
  /** MPIN/fingerprint unlock set up on this phone (null = not set up). */
  quick: QuickState | null;
  /** The lock screen is showing. */
  locked: boolean;
  reloadQuick: () => Promise<QuickState | null>;
  /** Quick unlock was turned off (by the user, or the server said so): forget it here. */
  dropQuick: () => Promise<void>;
  /** Lock screen → password sign-in. */
  toPassword: () => void;
  unlocked: () => void;
}
const C = createContext<Ctx | null>(null);

export const homeFor = (r: Role) => (r === 'SUPER_ADMIN' ? '/(admin)' : r === 'BROKER' ? '/(broker)' : '/(trader)/watchlist');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [quick, setQuick] = useState<QuickState | null>(null);
  const [locked, setLocked] = useState(false);
  const quickRef = useRef<QuickState | null>(null);
  const meRef = useRef<Me | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);

  const reloadQuick = useCallback(async () => {
    const q = await quickDevice();
    quickRef.current = q;
    setQuick(q);
    await setPersistRefresh(!q);
    return q;
  }, []);
  const dropQuick = useCallback(async () => {
    await forgetQuickDevice();
    quickRef.current = null;
    setQuick(null);
    await setPersistRefresh(true);
  }, []);
  /** Close every screen and sheet (nothing of the account stays mounted behind the lock), then lock. */
  const showLock = useCallback(() => {
    try { if (router.canDismiss()) router.dismissAll(); } catch { /* nothing to dismiss */ }
    router.replace('/login');
    setLocked(true);
  }, []);
  /** Lock now: end this session (a new one opens on unlock) and show the lock screen. */
  const lock = useCallback(async () => {
    setMe(null);
    showLock();
    await gql(`mutation { logout }`).catch(() => undefined);
    await clearSession();
  }, [showLock]);

  const reload = useCallback(async () => {
    try {
      const d = await gql<{ me: Me }>(`{ me { id username displayName role isDemo mfaEnabled termsAccepted } }`);
      setMe(d.me);
      return d.me;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => { setMe(null); if (quickRef.current) showLock(); else router.replace('/login'); });
    gql<{ appSettings: Settings }>(`{ appSettings { appName tickerMessages termsRules helplineUrl demoEnabled signupEnabled maxWatchlists minDeposit apiVersion } }`).then((d) => setSettings(d.appSettings)).catch(() => undefined);
    (async () => {
      // Quick unlock on: always open locked. Otherwise resume the saved session, if any.
      if (await reloadQuick()) setLocked(true);
      else if (await refreshSession()) { requestSplash(); await reload(); }
      setReady(true);
    })();
  }, [reload, reloadQuick, showLock]);

  // Lock again after a while in the background.
  useEffect(() => {
    let leftAt = 0;
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') leftAt = Date.now();
      else if (st === 'active' && leftAt && quickRef.current && meRef.current && Date.now() - leftAt > RELOCK_AFTER_MS) void lock();
      if (st === 'active') leftAt = 0;
    });
    return () => sub.remove();
  }, [lock]);

  // Live: if this session is signed out elsewhere (another device forced a login, an admin, idle timeout), leave now.
  useEffect(() => {
    if (!me) return;
    return subscribe<{ sessionEvents: { type: string; message: string } }>(`subscription { sessionEvents { type reason message at } }`, {}, ({ sessionEvents: e }) => {
      if (e.type !== 'SIGNED_OUT') return;
      rememberSignedOut(e.message);
      void clearSession().then(() => { setMe(null); if (quickRef.current) showLock(); else router.replace('/login'); });
    });
  }, [me]);

  const signIn = useCallback(async (a: string, r?: string | null) => { await storeSession(a, r); requestSplash(); return reload(); }, [reload]);
  const signOut = useCallback(async () => {
    // With quick unlock on, signing out returns to the lock screen (MPIN/fingerprint signs back in).
    if (quickRef.current && meRef.current?.id === quickRef.current.owner.userId) return lock();
    await gql(`mutation { logout }`).catch(() => undefined);
    await clearSession();
    setMe(null);
    router.replace('/login');
  }, [lock]);
  const toPassword = useCallback(() => { setLocked(false); router.replace('/login'); }, []);
  const unlocked = useCallback(() => setLocked(false), []);

  return <C.Provider value={{ me, ready, settings, reload, signIn, signOut, quick, locked, reloadQuick, dropQuick, toPassword, unlocked }}>{children}</C.Provider>;
}

export function useAuth() {
  const c = useContext(C);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
