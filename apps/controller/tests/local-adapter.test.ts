import { describe, expect, test } from 'bun:test';
import type { ServiceStatus } from '@nexathon/contracts';
import { LocalDemoAdapter, healthFromStatus } from '../src/local-adapter';

function demoServer(state: {
  services?: ServiceStatus[];
  stateBody?: Record<string, unknown>;
  journeyOk?: boolean;
  failActions?: boolean;
}): { url: string; close(): Promise<void>; actionLog: string[] } {
  const actionLog: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/api/demo/services') {
        return Response.json({ services: state.services ?? [] });
      }
      if (url.pathname === '/api/demo/state') {
        return Response.json(state.stateBody ?? {});
      }
      if (url.pathname === '/api/demo/journey') {
        return Response.json({ ok: state.journeyOk ?? true, detail: state.journeyOk ? 'tasks listed' : 'tasks unavailable' });
      }
      if (url.pathname.startsWith('/api/demo/actions/')) {
        const body = await request.json() as Record<string, string>;
        actionLog.push(`${url.pathname}:${JSON.stringify(body)}`);
        if (state.failActions) return Response.json({ error: 'injected failure' }, { status: 500 });
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true), actionLog };
}

const healthy: ServiceStatus[] = [
  { serviceId: 'frontend', health: 'healthy', checkedAt: '2026-01-01T00:00:00Z' },
  { serviceId: 'task-api', health: 'healthy', checkedAt: '2026-01-01T00:00:00Z' },
  { serviceId: 'dependency', health: 'healthy', checkedAt: '2026-01-01T00:00:00Z' },
];

describe('LocalDemoAdapter', () => {
  test('reads service statuses and the fault state', async () => {
    const demo = demoServer({ services: healthy, stateBody: { knownGoodRevision: 'rev-1', knownGoodConfig: { a: 'b' } } });
    try {
      const adapter = new LocalDemoAdapter({ demoBaseUrl: demo.url });
      expect(await adapter.serviceStatuses()).toEqual(healthy);
      const state = await adapter.faultState();
      expect(state.knownGoodRevision).toBe('rev-1');
      expect(healthFromStatus(healthy[0])).toBe('healthy');
      expect(healthFromStatus(undefined)).toBe('unknown');
    } finally {
      await demo.close();
    }
  });

  test('issues narrowly scoped restore and restart calls', async () => {
    const demo = demoServer({});
    try {
      const adapter = new LocalDemoAdapter({ demoBaseUrl: demo.url });
      await adapter.restoreRevision('rev-1');
      await adapter.restoreConfig('max_tasks', '100');
      await adapter.restartService('dependency');
      expect(demo.actionLog).toEqual([
        '/api/demo/actions/restore-revision:{"revision":"rev-1"}',
        '/api/demo/actions/restore-config:{"key":"max_tasks","value":"100"}',
        '/api/demo/actions/restart:{"service":"dependency"}',
      ]);
    } finally {
      await demo.close();
    }
  });

  test('journey failures surface as unknown instead of throwing', async () => {
    const demo = demoServer({});
    await demo.close();
    const adapter = new LocalDemoAdapter({ demoBaseUrl: demo.url, timeoutMs: 500 });
    const journey = await adapter.runJourney();
    expect(journey.result).toBe('unknown');
  });
});
