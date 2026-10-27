import type { Role } from '../db/schema';

export type OnLimit = 'ask' | 'replace_oldest' | 'block';
export interface RolePolicy { maxConcurrent: number; onLimit: OnLimit; idleMinutes: number; maxHours: number }

/** Why a session ended — sent to the signed-out device so it can say what happened. */
export const REVOKE_REASON = {
  forceLogin: 'force_login',
  replaced: 'replaced_by_new_login',
  idle: 'idle_timeout',
  admin: 'revoked_by_admin',
  user: 'revoked_by_user',
  logout: 'logout',
  passwordChanged: 'password_changed',
  passwordReset: 'password_reset',
  reuse: 'refresh_reuse',
} as const;

export function signedOutMessage(reason?: string | null): { code: string; message: string } {
  switch (reason) {
    case REVOKE_REASON.forceLogin:
    case REVOKE_REASON.replaced:
      return { code: 'SESSION_REPLACED', message: 'You were signed out because your account was signed in on another device.' };
    case REVOKE_REASON.idle:
      return { code: 'SESSION_IDLE', message: 'You were signed out after a period of inactivity.' };
    case REVOKE_REASON.admin:
      return { code: 'SESSION_REVOKED', message: 'An administrator signed this device out.' };
    case REVOKE_REASON.passwordChanged:
    case REVOKE_REASON.passwordReset:
      return { code: 'SESSION_REVOKED', message: 'Your password was changed, so this device was signed out.' };
    case REVOKE_REASON.reuse:
      return { code: 'SESSION_REVOKED', message: 'This device was signed out for your security. Please sign in again.' };
    case 'expired':
      return { code: 'SESSION_EXPIRED', message: 'Your session has ended. Please sign in again.' };
    default:
      return { code: 'SESSION_ENDED', message: 'Please sign in again.' };
  }
}

export const policyFor = (all: Record<string, RolePolicy>, role: Role): RolePolicy =>
  all[role] ?? { maxConcurrent: 0, onLimit: 'ask', idleMinutes: 60, maxHours: 24 };
