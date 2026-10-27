import type { ApolloServerPlugin } from '@apollo/server';
import { visit, type OperationDefinitionNode } from 'graphql';
import type { GqlContext } from '../common/context';
import { requestContext } from '../common/request-context';
import type { ActivityLogService } from './activity-log.service';

const SECRET_ARG = /^(password|currentPassword|newPassword|tempPassword|code|totp|refreshToken|mfaToken|token|secret)$/i;

function redactVars(v: Record<string, unknown> | undefined, secret: Set<string>, phone: Set<string>) {
  if (!v) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (secret.has(k)) out[k] = '[redacted]';
    else if (phone.has(k) && typeof val === 'string') out[k] = val.length > 4 ? `******${val.slice(-2)}` : '****';
    else out[k] = val;
  }
  return out;
}

/**
 * Logs every GraphQL operation over HTTP: who, from which IP and device, what (operation and
 * top-level fields, secrets redacted), outcome, error code and duration.
 */
export function activityPlugin(svc: () => ActivityLogService, quiet: () => Set<string>): ApolloServerPlugin<GqlContext> {
  return {
    async requestDidStart({ request }) {
      let opType: 'query' | 'mutation' | 'subscription' | 'invalid' = 'invalid';
      let fields = '';
      let opName: string | null = request.operationName ?? null;
      const secretVars = new Set<string>();
      const phoneVars = new Set<string>();
      let resolved = false;
      return {
        async didResolveOperation({ operation, document }) {
          // Variable names are chosen by the client, so find secrets by the ARGUMENT they feed (e.g. $p → password).
          const mark = (argName: string, value: { kind: string; name?: { value: string } }) => {
            if (value.kind !== 'Variable' || !value.name) return;
            if (SECRET_ARG.test(argName)) secretVars.add(value.name.value);
            else if (/^phone$/i.test(argName)) phoneVars.add(value.name.value);
          };
          visit(document, {
            Argument: (n) => mark(n.name.value, n.value),
            ObjectField: (n) => mark(n.name.value, n.value),
          });
          resolved = true;
          const op = operation as OperationDefinitionNode;
          opType = op.operation;
          const names = op.selectionSet.selections.map((s) => (s.kind === 'Field' ? s.name.value : s.kind)).filter((n) => n !== '__typename');
          fields = names.join(',');
          opName = opName ?? op.name?.value ?? names[0] ?? null;
        },
        async willSendResponse({ response, contextValue }) {
          const rc = requestContext.get();
          if (!rc) return;
          if (opType === 'query' && fields && fields.split(',').every((f) => quiet().has(f))) return; // admin-configured quiet reads
          const body = response.body.kind === 'single' ? response.body.singleResult : undefined;
          const err = body?.errors?.[0];
          const actor = contextValue.actor;
          svc().record({
            rc,
            userId: actor?.userId,
            role: actor?.role,
            sessionId: actor?.sessionId,
            opType,
            opName,
            fields,
            // Unparseable/invalid requests: we can't tell which variables are secrets, so store none.
            variables: !resolved ? null : redactVars(request.variables as Record<string, unknown> | undefined, secretVars, phoneVars),
            outcome: err ? 'ERROR' : 'OK',
            errorCode: err ? String(err.extensions?.code ?? 'ERROR') : null,
            durationMs: Date.now() - rc.startedAt,
          });
        },
      };
    },
  };
}
