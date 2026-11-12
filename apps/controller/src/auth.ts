import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DashboardRole } from './access';

const COOKIE = 'sentinel_session';
const MAX_BODY_BYTES = 2_000;
const SESSION_SECONDS = 60 * 60 * 24 * 7;

export interface RoleCredential {
  username: string;
  password: string;
}

export interface ExtraRoles {
  operator?: RoleCredential;
  viewer?: RoleCredential;
}

function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  return cookie?.slice(COOKIE.length + 1);
}

function sign(secret: string, username: string, exp: number, role: DashboardRole): string {
  return createHmac('sha256', secret).update(`${username}.${exp}.${role}`).digest('base64url');
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Optional role credentials from the environment, if both halves are present. */
function environmentRoles(env: Record<string, string | undefined>): ExtraRoles {
  const pair = (userKey: string, passwordKey: string): RoleCredential | undefined => {
    const username = env[userKey]?.trim();
    const password = env[passwordKey];
    return username && password ? { username, password } : undefined;
  };
  return {
    ...(pair('DASHBOARD_OPERATOR_USERNAME', 'DASHBOARD_OPERATOR_PASSWORD') ? { operator: pair('DASHBOARD_OPERATOR_USERNAME', 'DASHBOARD_OPERATOR_PASSWORD')! } : {}),
    ...(pair('DASHBOARD_VIEWER_USERNAME', 'DASHBOARD_VIEWER_PASSWORD') ? { viewer: pair('DASHBOARD_VIEWER_USERNAME', 'DASHBOARD_VIEWER_PASSWORD')! } : {}),
  };
}

export class DashboardAuth {
  private readonly signingKey: string;
  private readonly credentials: { role: DashboardRole; username: string; password: string }[];

  constructor(
    private readonly username: string,
    private readonly password: string,
    authSecret = process.env.DASHBOARD_AUTH_SECRET?.trim() ?? '',
    extraRoles: ExtraRoles = environmentRoles(process.env),
  ) {
    if (!username || !password) throw new Error('DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required.');
    this.signingKey = authSecret.length >= 8 ? authSecret : `${username}:${password}`;
    this.credentials = [
      { role: 'admin', username, password },
      ...(extraRoles.operator ? [{ role: 'operator' as DashboardRole, ...extraRoles.operator }] : []),
      ...(extraRoles.viewer ? [{ role: 'viewer' as DashboardRole, ...extraRoles.viewer }] : []),
    ];
  }

  /** Roles configured beyond the always-present administrator. */
  configuredRoles(): DashboardRole[] {
    return this.credentials.map(credential => credential.role);
  }

  isPublic(pathname: string): boolean {
    return pathname === '/api/auth/login' || pathname === '/api/auth/session' || pathname === '/api/auth/logout'
      || pathname === '/api/github/webhook' || pathname === '/api/github/installed';
  }

  /** Role carried by a valid session cookie, if any. */
  roleOf(request: Request): DashboardRole | undefined {
    const token = cookieValue(request);
    if (!token) return undefined;
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const [expText, role, signature] = parts;
    const exp = Number(expText);
    if (!expText || !signature || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return undefined;
    const candidate = this.credentials.find(credential => {
      if (!sameSecret(signature, sign(this.signingKey, credential.username, exp, credential.role))) return false;
      return credential.role === role;
    });
    return candidate?.role;
  }

  isAuthorized(request: Request): boolean {
    return this.roleOf(request) !== undefined;
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/auth/')) return undefined;
    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      const role = this.roleOf(request);
      return Response.json({ authenticated: Boolean(role), ...(role ? { role } : {}) }, { status: role ? 200 : 401 });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return new Response(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } });
    }
    if (url.pathname !== '/api/auth/login' || request.method !== 'POST') return new Response('Not found.', { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: 'Expected JSON credentials.' }, { status: 400 }); }
    const values = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const receivedUser = typeof values.username === 'string' ? values.username : '';
    const receivedPassword = typeof values.password === 'string' ? values.password : '';
    const oversized = Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES;

    // Compare against every configured credential to avoid an early-exit timing signal.
    let matched: { role: DashboardRole; username: string } | undefined;
    for (const credential of this.credentials) {
      const userOk = sameSecret(receivedUser, credential.username);
      const passwordOk = sameSecret(receivedPassword, credential.password);
      if (userOk && passwordOk && !oversized) matched = credential;
    }
    if (!matched) return Response.json({ error: 'Invalid username or password.' }, { status: 401 });

    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const token = `${exp}.${matched.role}.${sign(this.signingKey, matched.username, exp, matched.role)}`;
    return Response.json({ authenticated: true, role: matched.role }, { headers: { 'Set-Cookie': sessionCookie(token, SESSION_SECONDS) } });
  }

  unauthorized(reason = 'Authentication required.'): Response {
    return Response.json({ error: reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  forbidden(reason = 'Your role does not permit this operation.'): Response {
    return Response.json({ error: reason }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
}