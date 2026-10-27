import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_WITHOUT_MFA, gqlContext, IS_PUBLIC, ROLES, STEP_UP } from '../common/context';
import { AppError, forbidden, unauthenticated } from '../common/errors';
import { ConfigService } from '../config-mgmt/config.service';
import type { Role } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import { requestContext } from '../common/request-context';

/**
 * Global guard for every GraphQL operation:
 *  1. authenticate (bearer access token → live session → ACTIVE user)
 *  2. role check (@Roles)
 *  3. privileged users must have MFA-verified sessions (unless @AllowWithoutMfa)
 *  4. step-up check (@RequireStepUp) for sensitive mutations
 * Resource-level checks (who may see which record) happen in services via PolicyService.
 */
@Injectable()
export class GqlAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType<string>() !== 'graphql') return true;
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
    const c = gqlContext(ctx);

    if (meta<boolean>(IS_PUBLIC)) return true;

    if (!c.actor) {
      if (!c.bearer) throw unauthenticated();
      c.actor = await this.auth.verifyAccess(c.bearer);
    }
    const actor = c.actor;
    requestContext.setActor(actor);

    const roles = meta<Role[]>(ROLES);
    if (roles?.length && !roles.includes(actor.role)) {
      await this.audit.recordStandalone({ actor, action: 'authz.role_denied', outcome: 'DENIED', ip: c.ip, metadata: { required: roles, op: ctx.getHandler().name } });
      throw forbidden();
    }

    if (actor.role === 'SUPER_ADMIN' && !actor.mfaVerified && !meta<boolean>(ALLOW_WITHOUT_MFA)) {
      if (await this.config.get('security.adminMfaRequired')) {
        throw new AppError('MFA_REQUIRED', 'Set up two-factor authentication to continue.');
      }
    }

    if (meta<boolean>(STEP_UP) && !this.auth.verifyStepUp(actor, c.stepUpToken)) {
      throw new AppError('STEP_UP_REQUIRED', 'Please confirm it is you to continue.');
    }
    return true;
  }
}
