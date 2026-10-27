'use client';
/** The animated K splash plays once after every sign-in (and when the app is opened with a saved session). */
const KEY = 'td.splash';
export function requestSplash() {
  try { sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked: skip the splash */ }
}
export function takeSplash(): boolean {
  try {
    const v = sessionStorage.getItem(KEY) === '1';
    sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return false;
  }
}
