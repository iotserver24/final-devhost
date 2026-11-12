import { afterEach, describe, expect, it } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { checkProject, runtimeLogSignal, type RuntimeLog, type DeploymentProvider, type ProbeResponse } from '../src/monitor';

const current = {
  id: 'current-deployment',
  immutableUrl: 'https://current-abc123.vercel.app',
  createdAt: '2026-10-23T11:59:30.000Z',
  commitSha: 'abc1234',
};
const previous = {
  id: 'previous-deployment',
  immutableUrl: 'https://previous-def456.vercel.app',
  createdAt: '2026-10-23T11:58:00.000Z',
  commitSha: 'def4567',
};
const at = new Date('2026-10-23T12:00:00.000Z');

function response(result: ProbeResponse['result'], evidence = `HTTP ${result === 'pass' ? 200 : 500}`): ProbeResponse {
  return { result, evidence };
}

function provider(options: {
  previousResult?: ProbeResponse['result'];
  recoveryResult?: ProbeResponse['result'];
} = {}) {
  const calls = { rollback: 0, previousProbes: 0, recoveryProbes: 0, paths: [] as string[] };
  const implementation: DeploymentProvider = {
    async getProductionDeployment() { return current; },
    async getPreviousDeployment() { return previous; },
    async probeImmutableDeployment(url, path) {
      calls.paths.push(path);
      if (url.startsWith('https://current-')) return response('fail', 'HTTP 500 api_key=top-secret');
      calls.previousProbes += 1;
      return response(options.previousResult ?? 'pass');
    },
    async rollbackProductionTo() {
      calls.rollback += 1;
      return { actionUrl: previous.immutableUrl };
    },
    async probeProduction() {
      if (calls.rollback === 0) return response('fail', 'HTTP 500 api_key=top-secret');
      calls.recoveryProbes += 1;
      return response(options.recoveryResult ?? 'pass');
    },
  };
  return { implementation, calls };
}

let store: IncidentStore;
afterEach(() => store?.close());

function monitorOptions(deploymentProvider: DeploymentProvider) {
  store = new IncidentStore(':memory:');
  return {
    projectId: 'sample-project',
    allowlistedProjectIds: new Set(['sample-project']),
    probePath: '/api/tasks',
    provider: deploymentProvider,
    store,
    now: () => at,
    wait: async () => {},
    recoveryDelayMs: 0,
  };
}

describe('checkProject', () => {
  it('starts immediately from three matching errors in one pull and passes the entire redacted batch to remediation', async () => {
    const fake = provider({ previousResult: 'fail' });
    const options = monitorOptions(fake.implementation);
    const stack = `Task service failed password=secret\n${'    at service.run (route.ts:10:5)\n'.repeat(150)}stack-end`;
    const logs: RuntimeLog[] = Array.from({ length: 3 }, (_, i) => ({
      id: `req-${i}:0`, message: stack, level: 'error', statusCode: 500, timestamp: at.getTime() + i, isError: true,
    }));
    logs.push({ id: 'healthy', message: 'healthy context', level: 'info', statusCode: 200, timestamp: at.getTime(), isError: false });
    const signal = runtimeLogSignal(logs, logs, current.id);
    expect(signal?.occurrences).toBe(3);
    let received: string[] | undefined;
    const result = await checkProject({ ...options, logSignal: signal, actions: {
      remediate: async incident => { received = incident.runtimeLogs; return { ok: true, message: 'Fix prepared' }; },
    } });
    expect(result.action).toBe('incident');
    expect(received).toHaveLength(4);
    expect(received?.[0]).toContain('stack-end');
    expect(received?.[0]).toContain('[REDACTED]');
    expect(received?.join('')).not.toContain('password=secret');
    expect(received?.[3]).toContain('healthy context');
    if (result.action === 'incident') expect((await store.get(result.incident.id))?.runtimeLogs).toEqual(received);
    expect(fake.calls.rollback).toBe(0);
    const repeated = await checkProject({ ...options, logSignal: signal });
    expect(repeated.action === 'incident' && repeated.duplicate).toBe(true);
  });

  it('does not combine small batches across pulls or count duplicate log IDs', async () => {
    const fake = provider();
    const options = monitorOptions(fake.implementation);
    const log: RuntimeLog = { id: 'req-1', message: 'task failed', level: 'error', timestamp: at.getTime(), isError: true };
    const two = [log, { ...log, id: 'req-2' }];
    expect(runtimeLogSignal(two, two, current.id)).toBeUndefined();
    expect(runtimeLogSignal([log, log, log], [log], current.id)).toBeUndefined();
    const three = [...two, { ...log, id: 'req-3' }];
    expect(runtimeLogSignal(three, [], current.id)).toBeUndefined();
    expect(runtimeLogSignal([...three, { ...log, id: 'req-4' }], three, current.id)?.occurrences).toBe(4);
    expect(runtimeLogSignal([log, { ...log, id: 'b', message: 'different failure' }, { ...log, id: 'c', message: 'another failure' }], three, current.id)).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const result = await checkProject({ ...options, logSignal: { evidence: 'two errors', occurrences: 2, logs: two, deploymentId: current.id } });
      expect(result.action).toBe('monitor');
    }
    expect(fake.calls.rollback).toBe(0);
  });

  it('does not act on a log batch belonging to a deployment that left production', async () => {
    const fake = provider();
    const options = monitorOptions(fake.implementation);
    const result = await checkProject({ ...options, logSignal: { evidence: 'Repeated error', occurrences: 3, logs: [], deploymentId: 'old-deployment' } });
    expect(result.action).toBe('unavailable');
    expect(fake.calls.rollback).toBe(0);
  });

  it('records a failed build for remediation without rolling back healthy production', async () => {
    const fake = provider();
    const buildProvider: DeploymentProvider = {
      ...fake.implementation,
      async getLatestDeploymentStatus() {
        return { id: 'failed-build', state: 'ERROR' as const, createdAt: at.toISOString(), commitSha: 'a'.repeat(40) };
      },
    };
    const options = monitorOptions(buildProvider);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected a build incident.');
    expect(result.incident.kind).toBe('build_failure');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.status).toBe('remediation_failed');
    expect(fake.calls.rollback).toBe(0);
  });

  it('records remediation and notification outcomes without hiding failures', async () => {
    const fake = provider({ previousResult: 'fail' });
    const notifications: string[] = [];
    const options = {
      ...monitorOptions(fake.implementation),
      actions: {
        remediate: async () => ({ ok: true as const, actionUrl: 'https://github.com/example/nexathon/pull/7', message: 'Draft PR opened.' }),
        notify: async (incident: { status: string }) => {
          notifications.push(incident.status);
          return { ok: false as const, message: 'Slack unavailable.' };
        },
      },
    };
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected a persistent-defect incident.');
    expect(result.incident.status).toBe('pr_opened');
    expect(result.incident.actionUrl).toBe('https://github.com/example/nexathon/pull/7');
    expect(result.incident.events.map(event => event.type)).toContain('draft_pr');
    expect(result.incident.events.map(event => event.type)).toContain('notification_failed');
    expect(notifications).toEqual(['pr_opened']);
  });

  it('waits for three failures, then rolls back once and verifies recovery', async () => {
    const fake = provider();
    const options = monitorOptions(fake.implementation);

    expect((await checkProject(options)).action).toBe('monitor');
    expect((await checkProject(options)).action).toBe('monitor');
    expect(fake.calls.rollback).toBe(0);

    const result = await checkProject(options);
    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.status).toBe('recovered');
    expect(result.incident.decision).toBe('rollback');
    expect(result.incident.previousDeploymentUrl).toBe(new URL(previous.immutableUrl).href);
    expect(result.incident.evidence.join(' ')).not.toContain('top-secret');
    expect(fake.calls.rollback).toBe(1);
    expect(fake.calls.recoveryProbes).toBe(1);
    expect(fake.calls.paths.every(path => path === '/api/tasks')).toBe(true);

    const afterRecovery = await checkProject(options);
    expect(afterRecovery.action).toBe('monitor');
    expect(fake.calls.rollback).toBe(1);
  });

  it('restores the previous deployment, then opens one draft PR for the failing commit', async () => {
    const fake = provider();
    let fixes = 0;
    const options = {
      ...monitorOptions(fake.implementation),
      actions: {
        remediate: async () => {
          fixes += 1;
          return { ok: true as const, actionUrl: 'https://github.com/example/testsite/pull/9', message: 'Draft PR opened for the failing commit.' };
        },
      },
    };

    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(fake.calls.rollback).toBe(1);
    expect(fixes).toBe(1);
    expect(result.incident.status).toBe('pr_opened');
    expect(result.incident.actionUrl).toBe('https://github.com/example/testsite/pull/9');
    expect(result.incident.events.map(event => event.type)).toEqual(expect.arrayContaining(['rollback_completed', 'verification', 'draft_pr']));
    expect(result.incident.evidence.join(' ')).toContain('previous deployment');
  });

  it('does not roll back when the predecessor has the same failure', async () => {
    const fake = provider({ previousResult: 'fail' });
    const options = monitorOptions(fake.implementation);
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.kind).toBe('persistent_defect');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.status).toBe('remediation_failed');
    expect(fake.calls.rollback).toBe(0);
  });

  it('records unavailable remediation when the predecessor is missing', async () => {
    const fake = provider();
    const noPredecessor: DeploymentProvider = {
      ...fake.implementation,
      async getPreviousDeployment() { return null; },
    };
    const options = monitorOptions(noPredecessor);
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(fake.calls.rollback).toBe(0);
  });

  it('records unavailable remediation for an older deployment', async () => {
    const fake = provider();
    const staleProvider: DeploymentProvider = {
      ...fake.implementation,
      async getProductionDeployment() { return { ...current, createdAt: '2026-10-23T10:00:00.000Z' }; },
    };
    const options = monitorOptions(staleProvider);
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(fake.calls.rollback).toBe(0);
  });

  it('escalates when recovery verification fails without retrying rollback', async () => {
    const fake = provider({ recoveryResult: 'fail' });
    const options = { ...monitorOptions(fake.implementation), recoveryAttempts: 2 };
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(fake.calls.rollback).toBe(1);
    expect(fake.calls.recoveryProbes).toBe(2);
  });

  it('records unavailable remediation outside the rollback allowlist', async () => {
    const fake = provider();
    const options = { ...monitorOptions(fake.implementation), allowlistedProjectIds: new Set<string>() };
    await checkProject(options);
    await checkProject(options);
    const result = await checkProject(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident result.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(fake.calls.rollback).toBe(0);
  });
});
