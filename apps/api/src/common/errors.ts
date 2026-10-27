import { GraphQLError } from 'graphql';

/**
 * Typed, client-safe errors. Messages never include internal details,
 * stack traces, or information that helps account enumeration.
 */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_USER_INPUT'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'STEP_UP_REQUIRED'
  | 'MFA_REQUIRED'
  | 'INSUFFICIENT_FUNDS'
  | 'ORDER_REJECTED'
  | 'NOT_ENABLED';

export class AppError extends GraphQLError {
  constructor(code: ErrorCode, message: string, extra: Record<string, unknown> = {}) {
    super(message, { extensions: { code, ...extra } });
  }
}

export const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Please sign in again.');
/** Deliberately identical to NOT_FOUND to avoid leaking existence of other users' records. */
export const notFound = (what = 'Record') => new AppError('NOT_FOUND', `${what} not found.`);
export const forbidden = (msg = 'You do not have permission to do this.') => new AppError('FORBIDDEN', msg);
export const badInput = (msg: string) => new AppError('BAD_USER_INPUT', msg);
export const conflict = (msg: string) => new AppError('CONFLICT', msg);
