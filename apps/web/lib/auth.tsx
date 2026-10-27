'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { gql, refreshSession, resetWs, setSignedOutHandler, tokenStore } from './api';
import { requestSplash } from './splash';

export type Role = 'SUPER_ADMIN' | 'BROKER' | 'TRADER';
export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  mode: 'SIMULATED' | 'LIVE';
  isDemo: boolean;
  mfaEnabled: boolean;
  termsAccepted: boolean;
}
export interface Settings {
  appName: string;
  tickerMessages: string[];
  termsRules: string[];
  helplineUrl: string;
  demoEnabled: boolean;
  tradingMode: string;
  signupEnabled: boolean;
  maxWatchlists: number;
  apiVersion: string;
}

const ME = `{ me { id username displayName role mode isDemo mfaEnabled termsAccepted } }`;

interface Ctx {
  me: Me | null;
  loading: boolean;
  settings: Settings | null;
  reload: () => Promise<Me | null>;
  signIn: (accessToken: string) => Promise<Me | null>;
  signOut: () => Promise<void>;
}
const AuthCtx = createContext<Ctx | null>(null);

export const homeFor = (r: Role) => (r === 'SUPER_ADMIN' ? '/admin' : r === 'BROKER' ? '/broker' : '/trader');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<Settings | null>(null);
  const router = useRouter();

  const reload = useCallback(async () => {
    try {
      const d = await gql<{ me: Me }>(ME);
      setMe(d.me);
      return d.me;
    } catch {
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => {
      setMe(null);
      router.replace('/login');
    });
    (async () => {
      gql<{ appSettings: Settings }>(`{ appSettings { appName tickerMessages termsRules helplineUrl demoEnabled tradingMode signupEnabled maxWatchlists apiVersion } }`)
        .then((d) => setSettings(d.appSettings))
        .catch(() => undefined);
      if (await refreshSession()) { requestSplash(); await reload(); }
      setLoading(false);
    })();
  }, [reload, router]);

  const signIn = useCallback(
    async (t: string) => {
      requestSplash();
      tokenStore.set(t);
      resetWs();
      return reload();
    },
    [reload],
  );

  const signOut = useCallback(async () => {
    await gql(`mutation { logout }`).catch(() => undefined);
    tokenStore.set(null);
    resetWs();
    setMe(null);
    router.replace('/login');
  }, [router]);

  return <AuthCtx.Provider value={{ me, loading, settings, reload, signIn, signOut }}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
