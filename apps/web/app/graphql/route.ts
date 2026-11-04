import type { NextRequest } from 'next/server';

/**
 * Same-origin relay for GraphQL HTTP calls: browser → this web server → API.
 *
 * Why: the API sets the refresh-token cookie (httpOnly, Secure, SameSite=Strict, Path=/graphql). When the web
 * app and the API live on different sites (e.g. two *.onrender.com hosts), browsers never send that cookie
 * back, so a page reload signs the user out. Relaying through the web origin makes the cookie first-party.
 *
 * Live updates (WebSocket subscriptions) still go straight to the API; they authenticate with the access token.
 *
 * The browser's IP is forwarded in x-k-client-ip together with x-k-proxy-secret (PROXY_SHARED_SECRET, server-only),
 * so the API logs and rate-limits the real user instead of this server.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * In production the hop to the API must be encrypted whenever it crosses the public internet: an http:// URL to a
 * public host (e.g. *.onrender.com) is upgraded to https://. Plain http is kept only for private-network hosts
 * (no dot, *.internal, 10.x / 172.16–31.x / 192.168.x, localhost), which never leave the provider's network.
 */
function secureApiUrl(raw: string): string {
  const u = new URL(raw.replace(/\/+$/, ''));
  const h = u.hostname;
  const privateHost = !h.includes('.') || h.endsWith('.internal') || h === 'localhost' || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (process.env.NODE_ENV === 'production' && u.protocol === 'http:' && !privateHost) { u.protocol = 'https:'; if (u.port === '80') u.port = ''; }
  return u.toString().replace(/\/+$/, '');
}
const API = secureApiUrl(process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000');
const SECRET = process.env.PROXY_SHARED_SECRET;
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

const FORWARD_REQ = ['x-upload', 'content-type', 'authorization', 'cookie', 'user-agent', 'x-client', 'x-step-up', 'x-request-id', 'apollo-require-preflight', 'accept', 'accept-language'];
const FORWARD_RES = ['content-type', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'cache-control'];
const MAX_BODY = 100 * 1024; // same limits as the API
const MAX_UPLOAD_BODY = 800 * 1024; // fee payment with a screenshot (x-upload: fee-proof)

/** Browser IP as seen by this server's load balancer (right-most X-Forwarded-For entry). */
function browserIp(req: NextRequest): string | null {
  if (!TRUST_PROXY) return null;
  const list = (req.headers.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list[list.length - 1] : null;
}

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  if (body.byteLength > (req.headers.get('x-upload') === 'fee-proof' ? MAX_UPLOAD_BODY : MAX_BODY)) return Response.json({ errors: [{ message: 'Request too large.', extensions: { code: 'BAD_REQUEST' } }] }, { status: 413 });

  const headers = new Headers();
  for (const h of FORWARD_REQ) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = browserIp(req);
  if (SECRET && ip) {
    headers.set('x-k-proxy-secret', SECRET);
    headers.set('x-k-client-ip', ip);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API}/graphql`, { method: 'POST', headers, body, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(65_000) });
  } catch {
    return Response.json({ errors: [{ message: 'The server is waking up or unreachable. Try again in a moment.', extensions: { code: 'NETWORK' } }] }, { status: 502 });
  }

  const out = new Headers();
  for (const h of FORWARD_RES) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  // Refresh-token cookie: the API sets it without a Domain, so it becomes a first-party cookie of this site.
  for (const c of upstream.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
