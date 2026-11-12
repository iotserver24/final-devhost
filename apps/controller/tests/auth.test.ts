import { describe, expect, it } from 'bun:test';
import { DashboardAuth } from '../src/auth';

describe('dashboard authentication', () => {
  it('logs in with configured credentials and protects API sessions with a cookie', async () => {
    const auth = new DashboardAuth('judge', 'correct horse');
    const denied = await auth.handle(new Request('http://localhost/api/auth/session'));
    expect(denied?.status).toBe(401);

    const login = await auth.handle(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'judge', password: 'correct horse' }),
    }));
    expect(login?.status).toBe(200);
    const cookie = login?.headers.get('set-cookie');
    expect(cookie).toContain('sentinel_session=');

    const authorized = new Request('http://localhost/api/auth/session', { headers: { cookie: cookie!.split(';')[0] } });
    expect((await auth.handle(authorized))?.status).toBe(200);
    expect(auth.isAuthorized(new Request('http://localhost/api/incidents', { headers: { cookie: cookie!.split(';')[0] } }))).toBe(true);
    expect(cookie).toContain('SameSite=Lax');
    const restarted = new DashboardAuth('judge', 'correct horse', 'dashboard-auth-secret');
    const stable = new DashboardAuth('judge', 'correct horse', 'dashboard-auth-secret');
    const stableLogin = await stable.handle(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'judge', password: 'correct horse' }),
    }));
    const stableCookie = stableLogin?.headers.get('set-cookie')?.split(';')[0];
    expect(stableCookie).toBeTruthy();
    expect(restarted.isAuthorized(new Request('http://localhost/api/incidents', { headers: { cookie: stableCookie! } }))).toBe(true);
  });

  it('does not reveal whether the username or password was wrong', async () => {
    const auth = new DashboardAuth('judge', 'correct horse');
    const response = await auth.handle(new Request('http://localhost/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: 'wrong' }),
    }));
    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: 'Invalid username or password.' });
  });
});
