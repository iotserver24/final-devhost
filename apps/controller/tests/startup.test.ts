import { describe, expect, it } from 'bun:test';

// A missing provider configuration must not make the setup API unreachable.
describe('controller startup', () => {
  it('serves settings and reports monitoring unavailable when required configuration is missing', async () => {
    const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop();
    const child = Bun.spawn([process.execPath, '--no-env-file', 'apps/controller/src/server.ts'], {
      cwd: import.meta.dir + '/../../..',
      env: {
        PATH: process.env.PATH ?? '', HOME: '/tmp', DATABASE_URL: ':memory:',
        DASHBOARD_USERNAME: 'startup-test', DASHBOARD_PASSWORD: 'startup-test',
        CONTROLLER_PORT: String(port), CONTROLLER_MONITOR_ENABLED: 'true', CONTROLLER_REMEDIATION_ENABLED: 'true',
      },
      stdout: 'ignore', stderr: 'ignore',
    });
    try {
      const origin = `http://127.0.0.1:${port}`;
      let login: Response | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          login = await fetch(`${origin}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'startup-test', password: 'startup-test' }),
          });
          break;
        } catch { await Bun.sleep(100); }
      }
      expect(login?.status).toBe(200);
      const cookie = login!.headers.get('set-cookie')!.split(';')[0]!;
      const watchResponse = await fetch(`${origin}/api/watch`, { headers: { Cookie: cookie } });
      const watch = await watchResponse.json() as { outcome: string; detail: string };
      expect(watchResponse.status).toBe(200);
      expect(watch.outcome).toBe('unavailable');
      expect(watch.detail).toContain('service/application ID');
      const settingsResponse = await fetch(`${origin}/api/settings`, { headers: { Cookie: cookie } });
      expect(settingsResponse.status).toBe(200);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});
