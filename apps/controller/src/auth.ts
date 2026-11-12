import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'sentinel_session';
const MAX_BODY_BYTES = 2_000;
const SESSION_SECONDS = 60 * 60 * 24 * 7;

function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request): string | undefined {
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  return cookie?.slice(COOKIE.length + 1);
}

function sign(secret: string, username: string, exp: number): string {
  return createHmac('sha256', secret).update(`${username}.${exp}`).digest('base64url');
}

function sessionCookie(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export class DashboardAuth {
  private readonly signingKey: string;

  constructor(private readonly username: string, private readonly password: string, authSecret = process.env.DASHBOARD_AUTH_SECRET?.trim() ?? '') {
    if (!username || !password) throw new Error('DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required.');
    this.signingKey = authSecret.length >= 8 ? authSecret : `${username}:${password}`;
  }

  isPublic(pathname: string): boolean {
    return pathname === '/api/auth/login' || pathname === '/api/auth/session' || pathname === '/api/auth/logout'
      || pathname === '/api/github/webhook' || pathname === '/api/github/installed';
  }

  isAuthorized(request: Request): boolean {
    const token = cookieValue(request);
    if (!token) return false;
    const [expText, signature] = token.split('.');
    const exp = Number(expText);
    if (!expText || !signature || !Number.isFinite(exp) || exp * 1000 <= Date.now()) return false;
    return sameSecret(signature, sign(this.signingKey, this.username, exp));
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/auth/')) return undefined;
    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      const authenticated = this.isAuthorized(request);
      return Response.json({ authenticated }, { status: authenticated ? 200 : 401 });
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
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES
      || !sameSecret(receivedUser, this.username) || !sameSecret(receivedPassword, this.password)) {
      return Response.json({ error: 'Invalid username or password.' }, { status: 401 });
    }
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const token = `${exp}.${sign(this.signingKey, this.username, exp)}`;
    return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': sessionCookie(token, SESSION_SECONDS) } });
  }

  unauthorized(): Response {
    return Response.json({ error: 'Authentication required.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
}
