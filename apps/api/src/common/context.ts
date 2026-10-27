import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request, Response } from 'express';
import type { Role } from '../db/schema';
import type { Loaders } from './loaders';

export interface Actor {
  userId: string;
  role: Role;
  sessionId: string;
  mfaVerified: boolean;
}

export interface GqlContext {
  req: Request;
  res?: Response;
  actor?: Actor;
  ip: string;
  userAgent: string;
  loaders: Loaders;
  /** raw bearer token from HTTP header or WS connectionParams */
  bearer?: string;
  stepUpToken?: string;
}

export function gqlContext(ctx: ExecutionContext): GqlContext {
  return GqlExecutionContext.create(ctx).getContext<GqlContext>();
}

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => gqlContext(ctx).actor);
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext) => gqlContext(ctx));

export const IS_PUBLIC = 'td:public';
export const ROLES = 'td:roles';
export const STEP_UP = 'td:stepup';
export const ALLOW_WITHOUT_MFA = 'td:nomfa';

/** Endpoint needs no authentication (login, OTP, refresh). Rate limits still apply. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Restrict to roles. Resource-level checks still happen in services via PolicyService. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
/** Requires a fresh step-up token (re-entered password or TOTP within the last few minutes). */
export const RequireStepUp = () => SetMetadata(STEP_UP, true);
/** Privileged users without MFA may still call this (MFA enrolment endpoints). */
export const AllowWithoutMfa = () => SetMetadata(ALLOW_WITHOUT_MFA, true);

/** Rate-limit helper: THROTTLE_SCALE lets load/e2e tests raise limits; production uses 1. */
export const lim = (n: number) => n * Math.max(1, Number(process.env.THROTTLE_SCALE ?? 1) || 1);
