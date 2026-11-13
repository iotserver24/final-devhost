import { describe, expect, test } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { assignCause } from '../src/monitor';
import { ensureLegacyWatchedService, parseWatchedService } from '../src/services';
import type { Incident } from '@nexathon/contracts';

function incident(): Incident {
  return {
    id: 'inc-test', kind: 'runtime_regression', status: 'detected', detectedAt: '2026-11-13T00:00:00.000Z',
    projectId: 'prj-app', evidence: ['upstream dependency returned 503'], events: [], decision: 'rollback',
  };
}

describe('watched services', () => {
  test('rejects a repository outside owner/name', () => {
    const parsed = parseWatchedService({ name: 'a', repository: 'nope', vercelProjectId: 'prj', productionHost: 'app.vercel.app', role: 'app' });
    expect('error' in parsed).toBe(true);
  });

  test('seeds one service from the saved single target', async () => {
    const store = new IncidentStore(':memory:');
    process.env.VERCEL_PROJECT_ID = 'prj_seed';
    process.env.REMEDIATOR_REPOSITORY = 'iotserver24/taskflow-sample';
    process.env.VERCEL_PRODUCTION_DOMAIN = 'final-devhost.vercel.app';
    process.env.CONTROLLER_PROBE_PATH = '/api/tasks';
    await ensureLegacyWatchedService(store);
    await ensureLegacyWatchedService(store);
    const services = await store.listWatchedServices();
    expect(services).toHaveLength(1);
    expect(services[0]?.repository).toBe('iotserver24/taskflow-sample');
    expect(services[0]?.probePath).toBe('/api/tasks');
  });

  test('an upstream failure on the app does not roll the app back', () => {
    const item = incident();
    const result = assignCause(item, { projectId: 'prj-app', serviceId: 'svc-app', serviceRole: 'app', logSignal: { evidence: 'upstream dependency returned 503', occurrences: 3, logs: [], deploymentId: 'dpl' } });
    expect(result).toBe('human');
    expect(item.cause).toBe('failing_dependency');
    expect(item.status).toBe('needs_human');
    expect(item.decision).toBe('escalate');
  });

  test('a dependency service keeps the failing_dependency cause', () => {
    const item = incident();
    item.evidence = ['probe failed'];
    const result = assignCause(item, { projectId: 'prj-dep', serviceId: 'svc-dep', serviceRole: 'dependency' });
    expect(result).toBe('continue');
    expect(item.cause).toBe('failing_dependency');
    expect(item.targetId).toBe('svc-dep');
    expect(item.actions?.[0]?.target).toBe('svc-dep');
    expect(item.actions?.[0]?.dryRun).toBe(true);
  });
});
