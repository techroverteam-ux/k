'use client';
/**
 * The animated K splash plays after every sign-in, and once per browser tab when the app is opened with a saved
 * session. Refreshing the page or opening another page in the same tab never replays it.
 */
const KEY = 'td.splash';
const SEEN = 'td.splash.seen';
export function requestSplash(reason: 'signin' | 'restore' = 'signin') {
  try {
    if (reason === 'restore' && sessionStorage.getItem(SEEN) === '1') return;
    sessionStorage.setItem(KEY, '1');
  } catch { /* storage blocked: skip the splash */ }
}
export function takeSplash(): boolean {
  try {
    const v = sessionStorage.getItem(KEY) === '1';
    sessionStorage.removeItem(KEY);
    if (v) sessionStorage.setItem(SEEN, '1');
    return v;
  } catch {
    return false;
  }
}
