'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Per-device display preferences. Stored in this browser only; nothing here affects money or permissions. */
export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  hideBalances: boolean;
  charts: boolean;
  sounds: boolean;
  numberSize: 'S' | 'M' | 'L' | 'XL';
  boldNumbers: boolean;
  /** Watchlist rows: simple (price + change) or detailed (bid/ask boxes with day low/high). */
  watchlistView: 'simple' | 'detailed';
}

export const DEFAULT_PREFS: Prefs = { theme: 'system', hideBalances: false, charts: true, sounds: true, numberSize: 'M', boldNumbers: false, watchlistView: 'detailed' };
const KEY = 'td.prefs.v1';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Reflect preferences on <html> so CSS can react (theme, number size, bold numbers). */
export function applyPrefs(p: Prefs) {
  const el = document.documentElement;
  if (p.theme === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', p.theme);
  el.setAttribute('data-numsize', p.numberSize);
  el.toggleAttribute('data-boldnums', p.boldNumbers);
}

const Ctx = createContext<{ prefs: Prefs; set: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }>({ prefs: DEFAULT_PREFS, set: () => undefined });

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    const p = load();
    setPrefs(p);
    applyPrefs(p);
  }, []);
  const set = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((cur) => {
      const next = { ...cur, [k]: v };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private mode: keep in memory */
      }
      applyPrefs(next);
      return next;
    });
  }, []);
  return <Ctx.Provider value={{ prefs, set }}>{children}</Ctx.Provider>;
}

export const usePrefs = () => useContext(Ctx);

/** Shows a money figure, or dots when "Hide balances" is on. */
export function Private({ children, width = 6 }: { children: ReactNode; width?: number }) {
  const { prefs } = usePrefs();
  return prefs.hideBalances ? <span aria-label="Hidden" title="Hidden — turn off “Hide balances” in Profile">{'•'.repeat(width)}</span> : <>{children}</>;
}

let audio: AudioContext | null = null;
/** Short confirmation tones for trade events (respects the "Trade sounds" preference). */
export function playTone(kind: 'fill' | 'placed' | 'reject', enabled: boolean) {
  if (!enabled || typeof window === 'undefined') return;
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const notes = kind === 'fill' ? [660, 880] : kind === 'placed' ? [520] : [300, 220];
    notes.forEach((f, i) => {
      const o = audio!.createOscillator();
      const g = audio!.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      const t = audio!.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g).connect(audio!.destination);
      o.start(t);
      o.stop(t + 0.12);
    });
  } catch {
    /* audio unavailable */
  }
}
