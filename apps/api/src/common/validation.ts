import { ValidationPipe, type ValidationError } from '@nestjs/common';
import type { ApolloServerPlugin } from '@apollo/server';
import { GraphQLError, visit } from 'graphql';
import { AppError } from './errors';

/** Shared patterns (also used by the clients' form validation). */
export const RX = {
  username: /^[a-z][a-z0-9_.]{3,39}$/,
  phoneIn: /^\+?[0-9][0-9\s-]{9,15}$/,
  otp: /^\d{6}$/,
  money: /^\d{1,12}(\.\d{1,2})?$/,
  idempotencyKey: /^[A-Za-z0-9_-]{8,120}$/,
  opName: /^[A-Za-z0-9_.]{1,120}$/,
  ip: /^[0-9a-fA-F:.]{2,64}$/,
  name: /^[\p{L}\p{M}][\p{L}\p{M}\s.'-]{0,118}[\p{L}\p{M}.]$/u,
};

const first = (errs: ValidationError[]): string => {
  for (const e of errs) {
    if (e.constraints) return Object.values(e.constraints)[0];
    if (e.children?.length) return first(e.children);
  }
  return 'Invalid input.';
};

/**
 * Global DTO validation for every GraphQL input object: unknown fields are rejected, types are
 * converted, and the first failure comes back as BAD_USER_INPUT with a readable message.
 */
export const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  validationError: { target: false, value: false },
  exceptionFactory: (errs) => new AppError('BAD_USER_INPUT', first(errs)),
});

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/; // C0 controls + bidi overrides
const MAX_STRING = 5000;
const MAX_ARRAY = 500;
const MAX_DEPTH = 8;

function check(v: unknown, path: string, depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${path}: too deeply nested`;
  if (typeof v === 'string') {
    if (v.length > MAX_STRING) return `${path}: too long`;
    if (CONTROL.test(v)) return `${path}: contains control characters`;
    return null;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY) return `${path}: too many items`;
    for (let i = 0; i < v.length; i++) { const e = check(v[i], `${path}[${i}]`, depth + 1); if (e) return e; }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const e = check(x, `${path}.${k}`, depth + 1); if (e) return e; }
  }
  return null;
}

/**
 * Input hygiene for every operation, including plain scalar arguments that DTO validation doesn't
 * cover: no control/bidi-override characters, bounded string and list sizes, bounded nesting.
 * Field-specific rules (formats, ranges) live on the input classes and in the services.
 */
export function inputHygienePlugin(): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document }) {
          const bad = check(request.variables ?? {}, 'variables');
          let lit: string | null = null;
          visit(document, { StringValue: (n) => { if (!lit && (n.value.length > MAX_STRING || CONTROL.test(n.value))) lit = 'a string argument is too long or contains control characters'; } });
          const msg = bad ?? lit;
          if (msg) throw new GraphQLError(`Invalid input: ${msg}.`, { extensions: { code: 'BAD_USER_INPUT' } });
        },
      };
    },
  };
}
