import type { LoggerService } from '@nestjs/common';
import { requestContext } from '../common/request-context';

const SECRET_RE = /(pass(word)?|otp|token|secret|authorization|cookie)["']?\s*[:=]\s*["']?[^"',\s}]+/gi;

/** One JSON line on stdout. Ship with your platform's agent (CloudWatch, Loki, Datadog, ELK). */
export function jsonLog(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const rc = requestContext.get();
  const line = JSON.stringify(
    { ts: new Date().toISOString(), level, msg, requestId: rc?.requestId, userId: rc?.userId, ip: rc?.ip, ...fields },
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  ).replace(SECRET_RE, '$1=[redacted]');
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

/**
 * Nest logger that writes structured JSON (enabled with LOG_FORMAT=json, the production default).
 * Every line carries the request id, user and IP when it was emitted during a request.
 */
export class JsonLogger implements LoggerService {
  log(message: unknown, context?: string) { jsonLog('info', String(message), { context }); }
  error(message: unknown, trace?: string, context?: string) { jsonLog('error', String(message), { context, trace: process.env.NODE_ENV === 'production' ? undefined : trace }); }
  warn(message: unknown, context?: string) { jsonLog('warn', String(message), { context }); }
  debug(message: unknown, context?: string) { jsonLog('debug', String(message), { context }); }
  verbose(message: unknown, context?: string) { jsonLog('debug', String(message), { context }); }
}
