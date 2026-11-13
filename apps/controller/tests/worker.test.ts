import { afterEach, describe, expect, it } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { startPollingWorker } from '../src/worker';
import type { DeploymentProvider } from '../src/monitor';

let store: IncidentStore;
afterEach(() => store?.close());

describe('startPollingWorker', () => {
  it('polls each distinct project and stops future checks', async () => {
    store = new IncidentStore(':memory:');
    const probedProjects: string[] = [];
    const provider: DeploymentProvider = {
      async getProductionDeployment(projectId) {
        probedProjects.push(projectId);
        return {
          id: `deployment-${projectId}`,
          immutableUrl: 'https://healthy-demo.vercel.app',
          createdAt: new Date().toISOString(),
        };
      },
      async getPreviousDeployment() { return null; },
      async probeImmutableDeployment() { return { result: 'pass', evidence: 'HTTP 200' }; },
      async rollbackProductionTo() { throw new Error('Should not roll back a healthy project.'); },
      async probeProduction() { return { result: 'pass', evidence: 'HTTP 200' }; },
    };
    const results: string[] = [];
    const worker = startPollingWorker({
      projectIds: ['project-a', 'project-b', 'project-a'],
      allowlistedProjectIds: new Set(['project-a', 'project-b']),
      probePath: '/api/tasks',
      provider,
      store,
      intervalMs: 300_000,
      startImmediately: false,
      onResult: projectId => { results.push(projectId); },
    });

    await worker.pollNow();
    expect(probedProjects).toEqual(['project-a', 'project-b']);
    expect(results).toEqual(['project-a', 'project-b']);

    await worker.stop();
    await worker.pollNow();
    expect(probedProjects).toHaveLength(2);
  });

  it('keeps checking another project while one project is blocked', async () => {
    store = new IncidentStore(':memory:');
    let releaseSlow!: () => void;
    let resolveFast!: () => void;
    const slow = new Promise<void>(resolve => { releaseSlow = resolve; });
    const fastTwice = new Promise<void>(resolve => { resolveFast = resolve; });
    let fastChecks = 0;
    const provider: DeploymentProvider = {
      async getProductionDeployment(projectId) {
        if (projectId === 'slow') await slow;
        else if (++fastChecks === 2) resolveFast();
        return { id: `deployment-${projectId}`, immutableUrl: 'https://healthy-demo.vercel.app', createdAt: new Date().toISOString() };
      },
      async getPreviousDeployment() { return null; },
      async probeImmutableDeployment() { return { result: 'pass', evidence: 'HTTP 200' }; },
      async rollbackProductionTo() { throw new Error('Should not roll back'); },
      async probeProduction() { return { result: 'pass', evidence: 'HTTP 200' }; },
    };
    const worker = startPollingWorker({
      projectIds: ['slow', 'fast'], allowlistedProjectIds: new Set(),
      probePath: '/api/tasks', provider, store, intervalMs: 1_000,
    });
    try {
      await Promise.race([fastTwice, Bun.sleep(4_000).then(() => { throw new Error('Fast project did not run its second check'); })]);
      expect(fastChecks).toBeGreaterThanOrEqual(2);
    } finally {
      releaseSlow();
      await worker.stop();
    }
  });

  it('checks deployment status less often than runtime probes', async () => {
    store = new IncidentStore(':memory:');
    let deploymentStatusChecks = 0;
    let runtimeChecks = 0;
    const provider: DeploymentProvider = {
      async getProductionDeployment() {
        runtimeChecks += 1;
        return { id: 'deployment', immutableUrl: 'https://healthy-demo.vercel.app', createdAt: new Date().toISOString() };
      },
      async getLatestDeploymentStatus() {
        deploymentStatusChecks += 1;
        return { id: 'deployment', state: 'READY' as const, createdAt: new Date().toISOString() };
      },
      async getPreviousDeployment() { return null; },
      async probeImmutableDeployment() { return { result: 'pass', evidence: 'HTTP 200' }; },
      async rollbackProductionTo() { throw new Error('Should not roll back a healthy project.'); },
      async probeProduction() { return { result: 'pass', evidence: 'HTTP 200' }; },
    };
    const worker = startPollingWorker({
      projectIds: ['project-a'], allowlistedProjectIds: new Set(['project-a']), probePath: '/api/tasks', provider, store,
      intervalMs: 300_000, deploymentStatusIntervalMs: 60_000, startImmediately: false,
    });
    await worker.pollNow();
    await worker.pollNow();
    expect(runtimeChecks).toBe(2);
    expect(deploymentStatusChecks).toBe(1);
    await worker.stop();
  });

  it('keeps provider methods on polls that skip deployment status', async () => {
    store = new IncidentStore(':memory:');
    let runtimeChecks = 0;
    class Provider {
      async getProductionDeployment() {
        runtimeChecks += 1;
        return { id: 'deployment', immutableUrl: 'https://healthy-demo.vercel.app', createdAt: new Date().toISOString() };
      }
      async getLatestDeploymentStatus() {
        return { id: 'deployment', state: 'READY' as const, createdAt: new Date().toISOString() };
      }
      async getPreviousDeployment() { return null; }
      async probeImmutableDeployment() { return { result: 'pass' as const, evidence: 'HTTP 200' }; }
      async rollbackProductionTo(): Promise<{ actionUrl?: string }> { throw new Error('Should not roll back a healthy project.'); }
      async probeProduction() { return { result: 'pass' as const, evidence: 'HTTP 200' }; }
    }
    const worker = startPollingWorker({
      projectIds: ['project-a'], allowlistedProjectIds: new Set(['project-a']), probePath: '/api/tasks',
      provider: new Provider(), store, intervalMs: 300_000, deploymentStatusIntervalMs: 60_000, startImmediately: false,
    });
    await worker.pollNow();
    await worker.pollNow();
    expect(runtimeChecks).toBe(2);
    await worker.stop();
  });
});
