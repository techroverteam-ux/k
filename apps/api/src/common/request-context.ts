import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import type { Role } from '../db/schema';

/**
 * Per-request context, available anywhere in the call stack without threading parameters.
 * Every audit event, order and payment row is stamped from here, so all of them carry the
 * same request id, client IP, device (user agent) and session.
 */
export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  client: string; // 'web' | 'mobile' | 'other'
  startedAt: number;
  userId?: string;
  role?: Role;
  sessionId?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  get: (): RequestContext | undefined => als.getStore(),
  run: <T>(ctx: RequestContext, fn: () => T): T => als.run(ctx, fn),
  /** Called by the auth guard once the caller is known. */
  setActor(a: { userId: string; role: Role; sessionId?: string }) {
    const s = als.getStore();
    if (s) Object.assign(s, { userId: a.userId, role: a.role, sessionId: a.sessionId });
  },
};

/** Strip IPv4-mapped IPv6 prefix and port noise so the same client always logs the same IP. */
export function normalizeIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  let v = ip.trim();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1') v = '127.0.0.1';
  return v.slice(0, 64);
}

/**
 * The real client IP.
 * - TRUST_PROXY=false (default): the TCP peer address. X-Forwarded-For is IGNORED, so clients can't spoof it.
 * - TRUST_PROXY=true: the address added by the one trusted proxy in front of us (right-most X-Forwarded-For entry).
 *   Only enable this when the API is reachable exclusively through that load balancer.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress;
  if (!env().TRUST_PROXY) return normalizeIp(peer);
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return normalizeIp(list.length ? list[list.length - 1] : peer);
}

const REQ_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function contextFromRequest(req: IncomingMessage): RequestContext {
  const hdr = req.headers['x-request-id'];
  const given = typeof hdr === 'string' && REQ_ID_RE.test(hdr) ? hdr : undefined;
  const xc = req.headers['x-client'];
  return {
    requestId: given ?? randomUUID(),
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
    client: xc === 'mobile' ? 'mobile' : xc === 'web' ? 'web' : 'other',
    startedAt: Date.now(),
  };
}

/** Express middleware: open a request context and echo the request id back to the client. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction) {
  const ctx = contextFromRequest(req);
  res.setHeader('x-request-id', ctx.requestId);
  als.run(ctx, next);
}
