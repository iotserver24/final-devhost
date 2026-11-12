import { describe, expect, it } from 'bun:test';
import { CoolifyProvider, RailwayProvider, RenderProvider } from '../src/platform-providers';

describe('alternate deployment providers', () => {
  it('uses Render deploy, log, and rollback endpoints only after predecessor validation', async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input.toString()); calls.push({ url, init });
      if (url.pathname.endsWith('/deploys')) return Response.json([
        { deploy: { id: 'current', status: 'live', createdAt: '2026-10-23T12:00:00Z', commit: { id: 'new' } } },
        { deploy: { id: 'previous', status: 'live', createdAt: '2026-10-23T11:00:00Z', commit: { id: 'old' } } },
      ]);
      if (url.pathname === '/v1/logs') return Response.json({ logs: [{ message: 'database connection refused' }] });
      if (url.pathname.endsWith('/rollback')) return Response.json({}, { status: 201 });
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    const provider = new RenderProvider({ accessToken: 'token', serviceId: 'srv', ownerId: 'owner', productionUrl: 'https://app.example.com', fetch: fetchMock });
    expect((await provider.getPreviousDeployment('srv', 'current'))?.id).toBe('previous');
    expect(await provider.getDeploymentLogs('srv', 'current')).toEqual(['database connection refused']);
    await provider.rollbackProductionTo('srv', 'previous');
    expect(calls.some(call => call.url.pathname === '/v1/services/srv/rollback' && call.init.method === 'POST')).toBe(true);
  });

  it('reads Railway GraphQL logs and redeploys the immediate predecessor', async () => {
    const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchMock = (async (_: RequestInfo | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)); bodies.push(body);
      if (body.query.includes('deploymentLogs')) return Response.json({ data: { deploymentLogs: [{ message: 'build failed' }] } });
      if (body.query.includes('deploymentRedeploy')) return Response.json({ data: { deploymentRedeploy: { id: 'rollback' } } });
      return Response.json({ data: { deployments: { edges: [{ node: { id: 'current', status: 'SUCCESS', createdAt: '2026-10-23T12:00:00Z' } }, { node: { id: 'previous', status: 'SUCCESS', createdAt: '2026-10-23T11:00:00Z' } }] } } });
    }) as typeof globalThis.fetch;
    const provider = new RailwayProvider({ token: 'token', projectId: 'project', serviceId: 'service', productionUrl: 'https://app.example.com', fetch: fetchMock });
    expect(await provider.getDeploymentLogs('service', 'current')).toEqual(['build failed']);
    await provider.rollbackProductionTo('service', 'previous');
    expect(bodies.some(body => body.query.includes('deploymentRedeploy') && body.variables.id === 'previous')).toBe(true);
  });

  it('uses Coolify deployment logs and rollback-image commit', async () => {
    const calls: Array<RequestInit> = [];
    const deployments = [
      { application_id: 'app', deployment_uuid: 'current', status: 'finished', created_at: '2026-10-23T12:00:00Z', commit: 'new', logs: 'latest line' },
      { application_id: 'app', deployment_uuid: 'previous', status: 'finished', created_at: '2026-10-23T11:00:00Z', commit: 'old', logs: 'build\nready' },
    ];
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => { calls.push(init); const url = new URL(input.toString()); return url.pathname.endsWith('/deployments') ? Response.json(deployments) : Response.json({ message: 'queued' }); }) as typeof globalThis.fetch;
    const provider = new CoolifyProvider({ accessToken: 'token', applicationId: 'app', baseUrl: 'https://coolify.example.com', productionUrl: 'https://app.example.com', fetch: fetchMock });
    expect(await provider.getDeploymentLogs('app', 'previous')).toEqual(['build', 'ready']);
    await provider.rollbackProductionTo('app', 'previous');
    expect(calls.some(call => call.method === 'POST' && String(call.body).includes('old'))).toBe(true);
  });
});
