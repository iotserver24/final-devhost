import { afterEach, describe, expect, it } from 'bun:test';
import type { Incident } from '@nexathon/contracts';
import { createIncidentApi } from '../src/api';
import { IncidentStore } from '../src/incident-store';

const incident: Incident = {
  id: 'incident-1',
  kind: 'runtime_regression',
  status: 'detected',
  detectedAt: '2026-10-23T12:00:00.000Z',
  projectId: 'sample-project',
  deploymentId: 'deployment-1',
  evidence: ['Three failed probes.'],
  events: [{ at: '2026-10-23T12:00:00.000Z', type: 'detected', message: 'Incident recorded.' }],
};

let store: IncidentStore;
afterEach(async () => {
  await store?.close();
});

describe('incident API', () => {
  it('returns persisted incident lists and event history', async () => {
    store = new IncidentStore(':memory:');
    await store.save(incident);
    const api = createIncidentApi(store);

    const list = await api(new Request('http://127.0.0.1/api/incidents'));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([incident]);

    const detail = await api(new Request('http://127.0.0.1/api/incidents/incident-1'));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(incident);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('persists incidents across database connections', async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    store = new IncidentStore(databaseUrl);
    await store.ready;
    await store.save(incident);
    await store.close();

    store = new IncidentStore(databaseUrl);
    await store.ready;
    expect(await store.get(incident.id)).toEqual(incident);
  });

  it('persists failure streaks and rollback claims in the configured backend', async () => {
    store = new IncidentStore(':memory:');
    const first = await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'fail', '2026-10-23T12:00:00.000Z');
    expect(first.consecutiveFailures).toBe(1);
    const second = await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'fail', '2026-10-23T12:00:30.000Z');
    expect(second.consecutiveFailures).toBe(2);
    expect(second.firstFailureAt).toBe('2026-10-23T12:00:00.000Z');
    expect(await store.claimRollback('deployment-1', '2026-10-23T12:01:00.000Z')).toBe(true);
    expect(await store.claimRollback('deployment-1', '2026-10-23T12:02:00.000Z')).toBe(false);
  });

  it('resets the failure streak after a passing or unknown probe', async () => {
    store = new IncidentStore(':memory:');
    await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'fail', '2026-10-23T12:00:00.000Z');
    await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'fail', '2026-10-23T12:00:30.000Z');
    expect((await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'pass', '2026-10-23T12:01:00.000Z')).consecutiveFailures).toBe(0);
    expect((await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'fail', '2026-10-23T12:01:30.000Z')).consecutiveFailures).toBe(1);
    expect((await store.recordProbe('sample-project', 'deployment-1', '/api/tasks', 'unknown', '2026-10-23T12:02:00.000Z')).consecutiveFailures).toBe(0);
  });

  it('does not expose mutation routes', async () => {
    store = new IncidentStore(':memory:');
    const response = await createIncidentApi(store)(new Request('http://127.0.0.1/api/incidents', { method: 'POST' }));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });

  it('returns not found for an unknown incident', async () => {
    store = new IncidentStore(':memory:');
    const response = await createIncidentApi(store)(new Request('http://127.0.0.1/api/incidents/missing'));
    expect(response.status).toBe(404);
  });
});
