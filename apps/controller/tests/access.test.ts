import { describe, expect, test } from 'bun:test';
import { AuditLog, RateLimiter, requiredRole, roleAllows } from '../src/access';
import { DashboardAuth } from '../src/auth';

describe('role policy', () => {
  test('read endpoints require viewer, actions require operator, settings require admin', () => {
    expect(requiredRole('GET', '/api/incidents')).toBe('viewer');
    expect(requiredRole('GET', '/api/services')).toBe('viewer');
    expect(requiredRole('POST', '/api/actions/dry-run')).toBe('operator');
    expect(requiredRole('POST', '/api/monitor/start')).toBe('operator');
    expect(requiredRole('POST', '/api/settings')).toBe('admin');
    expect(requiredRole('GET', '/api/settings')).toBe('admin');
    expect(requiredRole('POST', '/api/disconnect')).toBe('admin');
    expect(requiredRole('GET', '/api/vercel/connect')).toBe('admin');
  });

  test('roles are ordered viewer < operator < admin', () => {
    expect(roleAllows('viewer', 'viewer')).toBe(true);
    expect(roleAllows('viewer', 'operator')).toBe(false);
    expect(roleAllows('operator', 'operator')).toBe(true);
    expect(roleAllows('operator', 'admin')).toBe(false);
    expect(roleAllows('admin', 'admin')).toBe(true);
    expect(roleAllows(undefined, 'viewer')).toBe(false);
    expect(roleAllows(undefined, undefined)).toBe(true);
  });
});

describe('rate limiter', () => {
  test('blocks after the limit and resets after the window', () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1_000, 100, () => now);
    expect(limiter.check('ip').allowed).toBe(true);
    expect(limiter.check('ip').allowed).toBe(true);
    const blocked = limiter.check('ip');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(1_000);
    now = 1_001;
    expect(limiter.check('ip').allowed).toBe(true);
  });

  test('keys are independent and memory stays bounded', () => {
    const limiter = new RateLimiter(1, 1_000, 2, () => 0);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('c').allowed).toBe(true); // oldest evicted
    expect(limiter.check('a').allowed).toBe(true);
  });
});

describe('audit log', () => {
  test('records entries and keeps the newest within capacity', () => {
    const log = new AuditLog(2, () => new Date('2026-03-01T00:00:00Z'));
    log.record({ actor: 'operator', action: 'action.execute', target: 'task-api', outcome: 'allowed' });
    log.record({ actor: 'viewer', action: 'action.execute', target: 'task-api', outcome: 'denied', detail: 'role' });
    log.record({ actor: 'admin', action: 'settings.update', target: 'vercel', outcome: 'allowed' });
    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries.at(-1)!.actor).toBe('admin');
    expect(entries[0]!.at).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('role-scoped dashboard sessions', () => {
  const roles = { operator: { username: 'ops', password: 'ops-secret' }, viewer: { username: 'view', password: 'view-secret' } };

  async function login(auth: DashboardAuth, username: string, password: string) {
    const response = await auth.handle(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    }));
    return { status: response!.status, cookie: response!.headers.get('set-cookie')?.split(';')[0] };
  }

  test('each credential receives its own role in a signed cookie', async () => {
    const auth = new DashboardAuth('admin', 'admin-secret', 'a-sufficiently-long-secret', roles);
    const admin = await login(auth, 'admin', 'admin-secret');
    const operator = await login(auth, 'ops', 'ops-secret');
    const viewer = await login(auth, 'view', 'view-secret');
    expect(admin.status).toBe(200);
    expect(auth.roleOf(new Request('http://localhost/x', { headers: { cookie: admin.cookie! } }))).toBe('admin');
    expect(auth.roleOf(new Request('http://localhost/x', { headers: { cookie: operator.cookie! } }))).toBe('operator');
    expect(auth.roleOf(new Request('http://localhost/x', { headers: { cookie: viewer.cookie! } }))).toBe('viewer');
  });

  test('a tampered role in the cookie is rejected', async () => {
    const auth = new DashboardAuth('admin', 'admin-secret', 'a-sufficiently-long-secret', roles);
    const viewer = await login(auth, 'view', 'view-secret');
    const [exp, , signature] = viewer.cookie!.split('=')[1]!.split('.');
    const forged = `sentinel_session=${exp}.admin.${signature}`;
    expect(auth.roleOf(new Request('http://localhost/x', { headers: { cookie: forged } }))).toBeUndefined();
  });

  test('expired sessions are rejected', async () => {
    const auth = new DashboardAuth('admin', 'admin-secret', 'a-sufficiently-long-secret', roles);
    const cookie = await login(auth, 'admin', 'admin-secret');
    const expired = `sentinel_session=1.admin.deadbeef`;
    expect(auth.roleOf(new Request('http://localhost/x', { headers: { cookie: expired } }))).toBeUndefined();
    expect(cookie.status).toBe(200);
  });

  test('wrong role credential is rejected', async () => {
    const auth = new DashboardAuth('admin', 'admin-secret', 'a-sufficiently-long-secret', roles);
    expect((await login(auth, 'ops', 'wrong')).status).toBe(401);
    expect((await login(auth, 'nobody', 'ops-secret')).status).toBe(401);
  });

  test('configured roles are reported for the trust model', () => {
    const auth = new DashboardAuth('admin', 'admin-secret', 'a-sufficiently-long-secret', roles);
    expect(auth.configuredRoles()).toEqual(['admin', 'operator', 'viewer']);
  });
});