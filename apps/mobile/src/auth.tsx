import * as Device from 'expo-device';
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { clearSession, gql, refreshSession, rememberSignedOut, setSignedOutHandler, storeSession, subscribe } from './api';
import { requestSplash } from './splash';

export type Role = 'SUPER_ADMIN' | 'BROKER' | 'TRADER';
export interface Me { id: string; username: string; displayName: string; role: Role; isDemo: boolean; mfaEnabled: boolean; termsAccepted: boolean }
export interface Settings { appName: string; tickerMessages: string[]; termsRules: string[]; helplineUrl: string; demoEnabled: boolean; signupEnabled: boolean; maxWatchlists: number; apiVersion: string }

export const DEVICE_NAME = `${Device.manufacturer ?? ''} ${Device.modelName ?? 'Mobile'}`.trim();

interface Ctx { me: Me | null; ready: boolean; settings: Settings | null; reload: () => Promise<Me | null>; signIn: (access: string, refresh?: string | null) => Promise<Me | null>; signOut: () => Promise<void> }
const C = createContext<Ctx | null>(null);

export const homeFor = (r: Role) => (r === 'SUPER_ADMIN' ? '/(admin)' : r === 'BROKER' ? '/(broker)' : '/(trader)');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

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
    setSignedOutHandler(() => { setMe(null); router.replace('/login'); });
    gql<{ appSettings: Settings }>(`{ appSettings { appName tickerMessages termsRules helplineUrl demoEnabled signupEnabled maxWatchlists apiVersion } }`).then((d) => setSettings(d.appSettings)).catch(() => undefined);
    (async () => {
      if (await refreshSession()) { requestSplash(); await reload(); }
      setReady(true);
    })();
  }, [reload]);

  // Live: if this session is signed out elsewhere (another device forced a login, an admin, idle timeout), leave now.
  useEffect(() => {
    if (!me) return;
    return subscribe<{ sessionEvents: { type: string; message: string } }>(`subscription { sessionEvents { type reason message at } }`, {}, ({ sessionEvents: e }) => {
      if (e.type !== 'SIGNED_OUT') return;
      rememberSignedOut(e.message);
      void clearSession().then(() => { setMe(null); router.replace('/login'); });
    });
  }, [me]);

  const signIn = useCallback(async (a: string, r?: string | null) => { await storeSession(a, r); requestSplash(); return reload(); }, [reload]);
  const signOut = useCallback(async () => {
    await gql(`mutation { logout }`).catch(() => undefined);
    await clearSession();
    setMe(null);
    router.replace('/login');
  }, []);

  return <C.Provider value={{ me, ready, settings, reload, signIn, signOut }}>{children}</C.Provider>;
}

export function useAuth() {
  const c = useContext(C);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
