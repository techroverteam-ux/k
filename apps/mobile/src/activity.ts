/** Human labels for logged operations and devices (shared wording with the mobile app). */
const ACTIONS: Record<string, string> = {
  login: 'Signed in', completeMfaLogin: 'Signed in with 2-step code', verifyDemoOtp: 'Signed in with OTP', requestDemoOtp: 'Requested an OTP',
  logout: 'Signed out', refresh: 'Session renewed', revokeSession: 'Signed out a device', revokeOtherSessions: 'Signed out other devices',
  changePassword: 'Changed password', stepUp: 'Confirmed identity', beginMfaEnrollment: 'Started 2-step setup', confirmMfaEnrollment: 'Turned on 2-step verification', acceptTerms: 'Accepted the rules',
  placeOrder: 'Placed an order', forceLogin: 'Signed in on this device (other device signed out)', acceptTradingConsent: 'Accepted the trading rules', resetPassword_: '', statementLink: 'Downloaded a statement', 'statement.pdf': 'Downloaded a statement', registerTrader: 'Applied for an account', requestSignupOtp: 'Requested a sign-up code', requestPasswordReset: 'Requested a password reset', resetPassword: 'Reset the password', cancelOrder: 'Cancelled an order', addToWatchlist: 'Added to watchlist', removeFromWatchlist: 'Removed from watchlist',
  requestPayment: 'Requested a fund transfer', cancelPayment: 'Cancelled a fund request', approvePayment: 'Approved a fund request', rejectPayment: 'Rejected a fund request',
  createUser: 'Created an account', approveUser: 'Approved an account', setUserStatus: 'Changed account status', assignTraderToBroker: 'Changed a broker assignment', resetUserPassword: 'Reset a password',
  proposeConfigChange: 'Proposed a setting change', decideConfigChange: 'Decided a setting change', proposeConfigRollback: 'Proposed a setting rollback',
  runReconciliation: 'Ran reconciliation', runLogMaintenance: 'Ran log maintenance', markNotificationsRead: 'Read notifications', liveFeed: 'Live prices connection',
};
export const actionLabel = (op?: string | null, fields?: string | null) => (op && ACTIONS[op]) || (fields && ACTIONS[fields.split(',')[0]]) || op || fields || 'Request';

export function deviceLabel(ua?: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
  const app = /Expo|okhttp|CFNetwork|Darwin/i.test(ua) && !/Mozilla/i.test(ua) ? 'The K app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua.split(/[\s/]/)[0];
  return [app, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

/** Full timestamp with seconds in IST (computed manually: Hermes Intl time-zone support varies by device). */
export function stamp(d: string | Date) {
  const t = new Date(new Date(d).getTime() + 5.5 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()];
  return `${p(t.getUTCDate())} ${m} ${t.getUTCFullYear()}, ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())} IST`;
}

export interface ActivityEntry { id: string; at: string; requestId: string; userId?: string; username?: string; role?: string; sessionId?: string; ip: string; userAgent?: string; client?: string; opType: string; opName?: string; fields?: string; variablesJson?: string; outcome: string; errorCode?: string; durationMs?: number }
export const ACTIVITY_FIELDS = 'id at requestId userId username role sessionId ip userAgent client opType opName fields variablesJson outcome errorCode durationMs';

/** Labels for sign-in audit events. */
export const LOGIN_LABEL: Record<string, string> = {
  'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in', 'auth.mfa_failed': 'Wrong 2-step code', 'auth.login_locked': 'Blocked: account locked',
  'auth.login_inactive': 'Blocked: account not active', 'auth.refresh_reuse_detected': 'Old session token reused — device signed out', 'auth.password_reset': 'Password reset by OTP',
  'auth.password_reset_failed': 'Password reset failed', 'auth.concurrent_login_detected': 'Sign-in while already signed in elsewhere', 'auth.force_login': 'Signed in and signed out the other device',
  'auth.session_replaced': 'Signed in; oldest device signed out', 'auth.concurrent_login_blocked': 'Blocked: already signed in elsewhere', 'auth.sessions_revoked_by_admin': 'Signed out by an administrator', 'auth.session_revoked': 'Signed out', 'auth.sessions_revoked_all': 'Signed out other devices', 'auth.password_changed': 'Password changed',
};
export interface LoginEvent { seq: string; at: string; action: string; outcome: string; userId?: string; username?: string; role?: string; ip?: string; userAgent?: string; sessionId?: string; requestId?: string; detail?: string }
export const LOGIN_FIELDS = 'seq at action outcome userId username role ip userAgent sessionId requestId detail';
export interface ConsentRecord { id: string; userId: string; username?: string; displayName?: string; sessionId: string; termsVersion: string; rules: string[]; acceptedAt: string; ip: string; userAgent?: string; client?: string; requestId?: string }
export const CONSENT_FIELDS = 'id userId username displayName sessionId termsVersion rules acceptedAt ip userAgent client requestId';
