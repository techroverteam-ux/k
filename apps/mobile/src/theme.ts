/**
 * TradeDesk design tokens for native. Mirrors apps/web/app/globals.css (see docs/DESIGN_SYSTEM.md).
 */
import { useColorScheme } from 'react-native';
import { usePrefs } from './prefs';

const light = {
  bg: '#ffffff', bg2: '#f7f8fa', bg3: '#eff1f4', line: '#ebedf0', line2: '#dcdfe5',
  text: '#262a35', text2: '#697080', text3: '#9a9fac',
  brand: '#08a77b', brandPressed: '#06956d', brandInk: '#ffffff', brandSoft: '#e7f6f0',
  pos: '#08a77b', posSoft: '#e7f6f0', neg: '#e14f3b', negSoft: '#fdecea',
  warn: '#b97300', warnSoft: '#fff4de', info: '#3a66d1', infoSoft: '#eaf0fd',
  overlay: 'rgba(15,18,24,0.45)',
};
const dark: typeof light = {
  bg: '#121418', bg2: '#181b20', bg3: '#20242b', line: '#262a32', line2: '#343944',
  text: '#e9ebef', text2: '#a3a9b6', text3: '#767c89',
  brand: '#22b98b', brandPressed: '#2cc897', brandInk: '#06140f', brandSoft: '#0f2a21',
  pos: '#2ec293', posSoft: '#0f2a21', neg: '#ff6b57', negSoft: '#3a1a16',
  warn: '#f0b545', warnSoft: '#33270e', info: '#7c9df0', infoSoft: '#18223a',
  overlay: 'rgba(0,0,0,0.6)',
};
export type Theme = typeof light;
export const useTheme = (): Theme => {
  const sys = useColorScheme();
  const { prefs } = usePrefs();
  const mode = prefs.theme === 'system' ? sys : prefs.theme;
  return mode === 'dark' ? dark : light;
};

/** 4/8 spacing grid, radii, type scale, control sizes. */
export const S = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;
export const R = { xs: 4, sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;
export const FS = { xs: 12, sm: 13, md: 14, lg: 16, xl: 18, x2: 20, x3: 24, x4: 32 } as const;
export const CTL = { h: 44, hSm: 34, hLg: 52, row: 64, tap: 44 } as const;

/** Indian digit grouping for decimal strings (no float math). */
export function inr(v?: string | null, sign = false) {
  if (v === null || v === undefined || v === '') return '—';
  const neg = v.startsWith('-');
  const [w, f = '00'] = (neg ? v.slice(1) : v).split('.');
  const last3 = w.slice(-3), rest = w.slice(0, -3);
  const g = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  return `${neg ? '−' : sign && v !== '0.00' ? '+' : ''}${g}.${f.padEnd(2, '0').slice(0, 2)}`;
}
export type Tone = 'pos' | 'neg' | 'flat';
export const toneOfValue = (v?: string | null): Tone => (!v || v === '0.00' || v === '0' ? 'flat' : v.startsWith('-') ? 'neg' : 'pos');
export const toneColor = (t: Theme, v?: string | null) => ({ pos: t.pos, neg: t.neg, flat: t.text2 })[toneOfValue(v)];
/** @deprecated use toneColor */
export const toneOf = toneColor;
export const shortSymbol = (s: string) => s.replace(/\d{2}[A-Z]{3}FUT$/, '');
export const when = (d: string) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const initials = (n: string) => n.split(/[\s._]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
