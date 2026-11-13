import { describe, expect, test } from 'bun:test';
import { startVmAgent } from '../../vm-agent/src/server';
import { VmDeploymentProvider } from '../src/vm-provider';

const application = 'taskflow';
const token = 'vm-test-token';

describe('local VM agent rollback', () => {
  test('dry-runs, restores the previous image once, and rejects another target', async () => {
    const server = startVmAgent({ token, application });
    try {
      const provider = new VmDeploymentProvider({
        baseUrl: `http://127.0.0.1:${server.port}`,
        application,
        token,
      });

      const plan = await provider.planRollback(application);
      expect(plan).toMatchObject({ allowed: true, current: 'dpl-broken', previous: 'dpl-good' });
      expect((await provider.probeProduction(application)).result).toBe('fail');
      expect((await provider.getProductionDeployment(application))?.commitSha).toBe('sentinel-demo-app:broken');

      const unknown = await fetch(`http://127.0.0.1:${server.port}/v1/apps/${application}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'not-a-deployment' }),
      });
      expect(unknown.status).toBe(409);
      expect((await provider.probeProduction(application)).result).toBe('fail');

      const anon = await fetch(`http://127.0.0.1:${server.port}/v1/apps/${application}/status`);
      expect(anon.status).toBe(401);
      const other = await fetch(`http://127.0.0.1:${server.port}/v1/apps/other-app/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(other.status).toBe(404);

      await provider.rollbackProductionTo(application, 'dpl-good');
      expect((await provider.probeProduction(application)).result).toBe('pass');
      expect((await provider.getProductionDeployment(application))?.commitSha).toBe('sentinel-demo-app:good');
      const logs = await provider.getDeploymentLogs(application);
      expect(logs.join('\n')).toContain('sentinel-demo-app:good');
      expect(logs.join('\n')).not.toContain(token);

      await expect(provider.rollbackProductionTo(application, 'dpl-broken')).rejects.toThrow(/HTTP 409/);
      expect((await provider.getProductionDeployment(application))?.commitSha).toBe('sentinel-demo-app:good');
    } finally {
      server.stop(true);
    }
  });
});
