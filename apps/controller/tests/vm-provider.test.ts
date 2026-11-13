import { describe, expect, test } from 'bun:test';
import { VmDeploymentProvider } from '../src/vm-provider';

const app = 'taskflow';
const base = 'https://vm.example.test';

interface Recorded { path: string; method: string; body?: unknown }

function agentTransport(state: {
  current?: { id: string; image: string; deployedAt: string };
  previous?: { id: string; image: string; deployedAt: string };
  healthy?: boolean;
  statusCode?: number;
  logs?: string[];
  failRollback?: boolean;
}) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ path: url.pathname + url.search, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });

    if (url.pathname === `/v1/apps/${app}/status`) {
      if (state.statusCode) return Response.json({ error: 'down' }, { status: state.statusCode });
      return Response.json({
        ...(state.current ? { current: { ...state.current, healthy: state.healthy ?? true } } : {}),
        ...(state.previous ? { previous: state.previous } : {}),
      });
    }
    if (url.pathname === `/v1/apps/${app}/health`) {
      return Response.json({ ok: state.healthy ?? true }, { status: state.healthy === false ? 503 : 200 });
    }
    if (url.pathname === `/v1/apps/${app}/logs`) {
      return Response.json({ lines: state.logs ?? [] });
    }
    if (url.pathname === `/v1/apps/${app}/rollback` && method === 'POST') {
      if (state.failRollback) return Response.json({ error: 'rollback failed' }, { status: 500 });
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const current = { id: 'deploy-2', image: 'taskflow:v2', deployedAt: '2026-03-01T12:00:00Z' };
const previous = { id: 'deploy-1', image: 'taskflow:v1', deployedAt: '2026-03-01T10:00:00Z' };

describe('VM deployment provider', () => {
  test('reports current and previous deployments from the agent', async () => {
    const { fetchImpl } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    expect(await provider.getProductionDeployment(app)).toMatchObject({ id: 'deploy-2', createdAt: '2026-03-01T12:00:00.000Z' });
    expect(await provider.getPreviousDeployment(app, 'deploy-2')).toMatchObject({ id: 'deploy-1' });
  });

  test('refuses to resolve a previous deployment for an unknown current id', async () => {
    const { fetchImpl } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    expect(await provider.getPreviousDeployment(app, 'deploy-999')).toBeNull();
  });

  test('is scoped to a single application and rejects other ids', async () => {
    const { fetchImpl } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    expect(() => provider.rollbackProductionTo('other-app', 'deploy-1')).toThrow(/scoped/);
  });

  test('rolls back only to the confirmed previous deployment', async () => {
    const { fetchImpl, calls } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    await expect(provider.rollbackProductionTo(app, 'deploy-2')).rejects.toThrow(/not the confirmed previous/);
    await provider.rollbackProductionTo(app, 'deploy-1');
    const rollback = calls.find(call => call.method === 'POST');
    expect(rollback?.body).toEqual({ target: 'deploy-1' });
  });

  test('dry-run plan makes no mutating request', async () => {
    const { fetchImpl, calls } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    const plan = await provider.planRollback(app);
    expect(plan).toMatchObject({ allowed: true, current: 'deploy-2', previous: 'deploy-1' });
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  test('plan reports escalation when no previous deployment exists', async () => {
    const { fetchImpl } = agentTransport({ current });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    const plan = await provider.planRollback(app);
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toContain('escalation');
  });

  test('health probe maps status codes and reports failure', async () => {
    const healthy = agentTransport({ current, previous, healthy: true });
    expect((await new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl: healthy.fetchImpl }).probeProduction(app)).result).toBe('pass');
    const unhealthy = agentTransport({ current, previous, healthy: false });
    const probe = await new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl: unhealthy.fetchImpl }).probeProduction(app);
    expect(probe.result).toBe('fail');
    expect(probe.statusCode).toBe(503);
  });

  test('previous image probe is unknown rather than a guess', async () => {
    const { fetchImpl } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    expect((await provider.probeImmutableDeployment()).result).toBe('unknown');
  });

  test('logs are bounded and empty on failure', async () => {
    const many = Array.from({ length: 500 }, (_, index) => `line ${index}`);
    const ok = agentTransport({ current, previous, logs: many });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl: ok.fetchImpl, maxLogLines: 25 });
    const lines = await provider.getDeploymentLogs(app);
    expect(lines.length).toBeLessThanOrEqual(25);

    const failing = agentTransport({ current, previous, statusCode: 500 });
    const broken = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl: failing.fetchImpl });
    expect(await broken.getDeploymentLogs(app)).toEqual([]);
  });

  test('an unavailable agent throws from status so the monitor isolates it', async () => {
    const { fetchImpl } = agentTransport({ statusCode: 503 });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, fetchImpl });
    await expect(provider.getProductionDeployment(app)).rejects.toThrow(/HTTP 503/);
  });

  test('credentials never appear in requests and URL validation is enforced', async () => {
    const { fetchImpl, calls } = agentTransport({ current, previous });
    const provider = new VmDeploymentProvider({ baseUrl: base, application: app, token: 'agent-secret', fetchImpl });
    await provider.getProductionDeployment(app);
    expect(calls.every(call => !call.path.includes('agent-secret'))).toBe(true);
    expect(() => new VmDeploymentProvider({ baseUrl: 'http://vm.example.test', application: app })).toThrow(/https/);
    expect(() => new VmDeploymentProvider({ baseUrl: 'https://user:pass@vm.example.test', application: app })).toThrow(/credentials/);
  });
});