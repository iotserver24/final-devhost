import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { IncidentStore } from '../src/incident-store';
import {
  applyRemediationOutcome,
  checkProject,
  type Deployment,
  type DeploymentProvider,
  type MonitorOptions,
  type ProbeResponse,
} from '../src/monitor';

const projectId = 'sample-project';
const current: Deployment = {
  id: 'current-deployment',
  immutableUrl: 'https://current-abc123.vercel.app',
  createdAt: '2026-10-23T11:59:30.000Z',
  commitSha: 'a'.repeat(40),
};
const previous: Deployment = {
  id: 'previous-deployment',
  immutableUrl: 'https://previous-def456.vercel.app',
  createdAt: '2026-10-23T11:58:00.000Z',
  commitSha: 'b'.repeat(40),
};
const at = new Date('2026-10-23T12:00:00.000Z');

function probe(result: ProbeResponse['result']): ProbeResponse {
  return { result, evidence: `HTTP ${result === 'pass' ? 200 : 500}` };
}

function incidentId(project: string, deployment: string, path: string): string {
  const fingerprint = createHash('sha256').update(`${project}\0${deployment}\0${path}`).digest('hex').slice(0, 24);
  return `inc-${fingerprint}`;
}

function provider(overrides: Partial<DeploymentProvider> = {}) {
  const calls = { rollback: 0, productionResolves: 0 };
  const implementation: DeploymentProvider = {
    async getProductionDeployment() {
      calls.productionResolves += 1;
      return current;
    },
    async getPreviousDeployment() {
      return previous;
    },
    async probeImmutableDeployment(url) {
      if (url.startsWith('https://current-')) return probe('fail');
      return probe('pass');
    },
    async rollbackProductionTo() {
      calls.rollback += 1;
      return { actionUrl: previous.immutableUrl };
    },
    async probeProduction() {
      if (calls.rollback === 0) return probe('fail');
      return probe('pass');
    },
    ...overrides,
  };
  return { implementation, calls };
}

const stores: IncidentStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function makeOptions(
  implementation: DeploymentProvider,
  extra: Partial<MonitorOptions> & { store?: IncidentStore } = {},
): MonitorOptions {
  const store = extra.store ?? new IncidentStore(':memory:');
  stores.push(store);
  return {
    projectId,
    allowlistedProjectIds: new Set([projectId]),
    probePath: '/api/tasks',
    provider: implementation,
    store,
    now: () => at,
    wait: async () => {},
    recoveryDelayMs: 0,
    ...extra,
  };
}

async function driveFailure(options: MonitorOptions): Promise<ReturnType<typeof checkProject>> {
  await checkProject(options);
  await checkProject(options);
  return checkProject(options);
}

describe('monitor safety boundaries', () => {
  it('refuses an unsafe probe path', async () => {
    const { implementation } = provider();
    const result = await checkProject(makeOptions(implementation, { probePath: '/api/tasks?debug=1' }));
    expect(result.action).toBe('unavailable');
  });

  it('refuses a current deployment URL outside Vercel', async () => {
    const { implementation } = provider({
      getProductionDeployment: async () => ({ ...current, immutableUrl: 'https://evil.example.com/x' }),
    });
    const result = await checkProject(makeOptions(implementation));
    expect(result.action).toBe('unavailable');
  });

  it('ignores a protected immutable deployment URL when the public production probe passes', async () => {
    let immutableProbes = 0;
    const { implementation, calls } = provider({
      async probeImmutableDeployment() {
        immutableProbes += 1;
        return { result: 'unknown', evidence: 'HTTP 401 from current-abc123.vercel.app/api/tasks' };
      },
      async probeProduction() {
        return { result: 'pass', evidence: 'HTTP 200 from demo.example.com/api/tasks' };
      },
    });
    const result = await checkProject(makeOptions(implementation));
    expect(result.action).toBe('monitor');
    if (result.action === 'monitor') expect(result.consecutiveFailures).toBe(0);
    expect(immutableProbes).toBe(0);
    expect(calls.rollback).toBe(0);
  });

  it('reports the monitor unavailable when production resolution fails', async () => {
    const { implementation } = provider({
      getProductionDeployment: async () => { throw new Error('Vercel down'); },
    });
    const result = await checkProject(makeOptions(implementation));
    expect(result.action).toBe('unavailable');
  });

  it('records public probe failures even when deployment access is forbidden, without taking recovery actions', async () => {
    let remediations = 0;
    let health: ProbeResponse = { result: 'fail', statusCode: 500, evidence: 'HTTP 500 from public host' };
    const { implementation, calls } = provider({
      getProductionDeployment: async () => { throw new Error('Vercel HTTP 403'); },
      probeProduction: async () => health,
    });
    let clock = at;
    const options = makeOptions(implementation, {
      serviceId: 'hopper', now: () => clock,
      actions: { remediate: async () => { remediations++; return { ok: true, message: 'Unexpected' }; } },
    });
    const result = await driveFailure(options);
    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected a health incident');
    expect(result.incident.targetId).toBe('hopper');
    expect(result.incident.deploymentId).toBeUndefined();
    expect(result.incident.decision).toBe('escalate');
    expect(result.incident.status).toBe('needs_human');
    expect((await checkProject(options)).action).toBe('incident');
    expect((await options.store.get(result.incident.id))?.id).toBe(result.incident.id);
    expect(remediations).toBe(0);
    expect(calls.rollback).toBe(0);
    health = { result: 'pass', statusCode: 200, evidence: 'HTTP 200' };
    const passed = await checkProject(options);
    expect(passed.probe?.result).toBe('pass');
    clock = new Date(at.getTime() + 60_000);
    health = { result: 'fail', statusCode: 500, evidence: 'HTTP 500 again' };
    const next = await driveFailure(options);
    expect(next.action).toBe('incident');
    if (next.action === 'incident') expect(next.incident.id).not.toBe(result.incident.id);
  });

  it('does not create a public health incident for ignored HTTP failures during a provider outage', async () => {
    const { implementation, calls } = provider({
      getProductionDeployment: async () => { throw new Error('Vercel HTTP 403'); },
      probeProduction: async () => ({ result: 'fail', statusCode: 404, evidence: 'HTTP 404' }),
    });
    const options = makeOptions(implementation);
    expect((await driveFailure(options)).action).toBe('unavailable');
    expect(calls.rollback).toBe(0);
  });

  it('retries a fix interrupted before remediation after it becomes stale', async () => {
    let attempts = 0;
    let clock = at;
    const { implementation } = provider();
    const options = makeOptions(implementation, {
      now: () => clock,
      actions: { remediate: async () => { attempts++; return { ok: false, message: 'Test fix ended safely.' }; } },
    });
    const id = incidentId(projectId, current.id, '/api/tasks');
    await options.store.save({
      id, projectId, kind: 'runtime_regression', status: 'detected', decision: 'fix_pr',
      deploymentId: current.id, probePath: '/api/tasks', detectedAt: at.toISOString(),
      evidence: ['HTTP 500'], events: [{ at: at.toISOString(), type: 'detected', message: 'Detected failure.' }],
    });
    await driveFailure(options);
    expect(attempts).toBe(0);
    clock = new Date(at.getTime() + 121_000);
    await checkProject(options);
    expect(attempts).toBe(1);
    const saved = await options.store.get(id);
    expect(saved?.events.some(item => item.type === 'remediation_started')).toBe(true);
  });

  it('retries an interrupted pre-dispatch notification but leaves an active sandbox alone', async () => {
    for (const stage of ['remediation_retry', 'remediation_started'] as const) {
      let attempts = 0;
      const { implementation } = provider();
      const options = makeOptions(implementation, {
        now: () => new Date(at.getTime() + 121_000),
        actions: { remediate: async () => { attempts++; return { ok: false, message: 'Test fix ended safely.' }; } },
      });
      await options.store.save({
        id: incidentId(projectId, current.id, '/api/tasks'), projectId, kind: 'runtime_regression',
        status: 'remediating', decision: 'fix_pr', deploymentId: current.id, probePath: '/api/tasks',
        detectedAt: at.toISOString(), evidence: ['HTTP 500'],
        events: [{ at: at.toISOString(), type: stage, message: 'Fix state.' }],
      });
      await driveFailure(options);
      expect(attempts).toBe(stage === 'remediation_retry' ? 1 : 0);
    }
  });

  it('records unavailable remediation after rollback fails without retrying rollback', async () => {
    let rollbacks = 0;
    const { implementation } = provider({
      rollbackProductionTo: async () => {
        rollbacks += 1;
        throw new Error('Vercel 403');
      },
    });
    const options = makeOptions(implementation);
    const result = await driveFailure(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.evidence.join(' ')).toContain('Rollback request failed');
    expect(rollbacks).toBe(1);

    const again = await checkProject(options);
    expect(again.action).toBe('incident');
    if (again.action === 'incident') expect(again.duplicate).toBe(true);
    expect(rollbacks).toBe(1);
  });

  it('records the actual remediation failure for automatic retry', async () => {
    const { implementation } = provider({ probeImmutableDeployment: async () => probe('fail') });
    const options = makeOptions(implementation, {
      actions: { remediate: async () => ({ ok: false, message: 'Sandbox timed out.', evidence: ['proof'] }) },
    });
    const result = await driveFailure(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.kind).toBe('persistent_defect');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.evidence.join(' ')).toContain('Sandbox timed out.');
  });

  it('records an unexpected remediation failure', async () => {
    const { implementation } = provider({ probeImmutableDeployment: async () => probe('fail') });
    const options = makeOptions(implementation, {
      actions: { remediate: async () => { throw new Error('E2B down'); } },
    });
    const result = await driveFailure(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.evidence.join(' ')).toContain('Remediation failed unexpectedly');
  });

  it('automatically prepares a fix when rollback cannot be justified', async () => {
    for (const scenario of ['missing-predecessor', 'old-deployment', 'rollback-disabled', 'unknown-predecessor']) {
      let fixes = 0;
      const { implementation, calls } = provider({
        ...(scenario === 'missing-predecessor' ? { getPreviousDeployment: async () => null } : {}),
        ...(scenario === 'old-deployment' ? { getProductionDeployment: async () => ({ ...current, createdAt: '2026-10-01T00:00:00Z' }) } : {}),
        ...(scenario === 'unknown-predecessor' ? { probeImmutableDeployment: async () => probe('unknown') } : {}),
      });
      const options = makeOptions(implementation, {
        ...(scenario === 'rollback-disabled' ? { allowlistedProjectIds: new Set<string>() } : {}),
        actions: { remediate: async incident => {
          fixes++;
          expect(incident.status).toBe('remediating');
          expect(incident.decision).toBe('fix_pr');
          return { ok: true, message: 'Verified fix', actionUrl: 'https://github.com/example/app/pull/1' };
        } },
      });
      const result = await driveFailure(options);
      expect(result.action === 'incident' && result.incident.status).toBe('pr_opened');
      expect(fixes).toBe(1);
      expect(calls.rollback).toBe(0);
    }
  });

  it('starts repository remediation when rollback fails or was already claimed', async () => {
    for (const alreadyClaimed of [false, true]) {
      let fixes = 0;
      let rollbacks = 0;
      const { implementation } = provider({ rollbackProductionTo: async () => { rollbacks++; throw new Error('provider failure'); } });
      const options = makeOptions(implementation, {
        actions: { remediate: async () => { fixes++; return { ok: true, message: 'Fix prepared' }; } },
      });
      if (alreadyClaimed) await options.store.claimRollback(current.id, at.toISOString());
      const result = await driveFailure(options);
      expect(result.action === 'incident' && result.incident.status).toBe('pr_opened');
      expect(fixes).toBe(1);
      expect(rollbacks).toBe(alreadyClaimed ? 0 : 1);
    }
  });

  it('retries a legacy human-escalated incident even if it has a rollback action URL', async () => {
    let fixes = 0;
    const { implementation, calls } = provider();
    const options = makeOptions(implementation, {
      actions: { remediate: async () => { fixes++; return { ok: true, message: 'Fix prepared' }; } },
    });
    await options.store.save({
      id: incidentId(projectId, current.id, '/api/tasks'), kind: 'runtime_regression',
      projectId, deploymentId: current.id, commitSha: current.commitSha,
      status: 'needs_human', decision: 'escalate', detectedAt: at.toISOString(),
      actionUrl: previous.immutableUrl, evidence: ['Old rollback evidence'], events: [],
    });
    const result = await driveFailure(options);
    expect(result.action === 'incident' && result.incident.status).toBe('pr_opened');
    expect(fixes).toBe(1);
    expect(calls.rollback).toBe(0);
  });

  it('notifies before the fix and still remediates when mail fails', async () => {
    const order: string[] = [];
    const { implementation } = provider({ probeImmutableDeployment: async () => probe('fail') });
    const options = makeOptions(implementation, {
      actions: {
        notify: async () => {
          order.push('notify');
          throw new Error('smtp down');
        },
        remediate: async () => {
          order.push('remediate');
          return { ok: true, kind: 'waiting', message: 'Waiting for a comment on issue #3 before writing the fix. sandbox=sb' };
        },
      },
    });
    const result = await driveFailure(options);
    expect(result.action).toBe('incident');
    expect(order[0]).toBe('notify');
    expect(order.indexOf('notify')).toBeLessThan(order.indexOf('remediate'));
    expect(order.filter(step => step === 'remediate')).toHaveLength(1);
  });

  it('records a notification failure without losing the incident', async () => {
    const { implementation } = provider({ probeImmutableDeployment: async () => probe('fail') });
    const options = makeOptions(implementation, {
      actions: { notify: async () => { throw new Error('Slack down'); } },
    });
    const result = await driveFailure(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.events.map(event => event.type)).toContain('notification_failed');
    expect(result.incident.evidence.join(' ')).toContain('Notification failed unexpectedly');
  });

  it('sends a Slack report after a guarded rollback recovers', async () => {
    let notifications = 0;
    const { implementation } = provider();
    const options = makeOptions(implementation, {
      actions: {
        notify: async () => {
          notifications += 1;
          return { ok: true, message: 'sent' };
        },
      },
    });
    const result = await driveFailure(options);

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.status).toBe('recovered');
    expect(notifications).toBeGreaterThan(0);
  });

  it('records an interrupted rollback for automatic remediation on the next poll', async () => {
    const store = new IncidentStore(':memory:');
    await store.recordProbe(projectId, current.id, '/api/tasks', 'fail', at.toISOString());
    await store.recordProbe(projectId, current.id, '/api/tasks', 'fail', at.toISOString());
    await store.recordProbe(projectId, current.id, '/api/tasks', 'fail', at.toISOString());
    await store.save({
      id: incidentId(projectId, current.id, '/api/tasks'),
      kind: 'runtime_regression',
      status: 'detected',
      detectedAt: at.toISOString(),
      projectId,
      deploymentId: current.id,
      decision: 'rollback',
      evidence: [],
      events: [{ at: at.toISOString(), type: 'rollback_started', message: 'started' }],
    });

    const { implementation } = provider();
    const result = await checkProject(makeOptions(implementation, { store }));

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.duplicate).toBe(true);
    expect(result.updated).toBe(true);
  });

  it('prevents a second rollback for the same deployment across probe paths', async () => {
    const store = new IncidentStore(':memory:');
    expect(await store.claimRollback(current.id, at.toISOString())).toBe(true);

    const { implementation, calls } = provider();
    const result = await driveFailure(makeOptions(implementation, { store }));

    expect(result.action).toBe('incident');
    if (result.action !== 'incident') throw new Error('Expected an incident.');
    expect(result.incident.status).toBe('remediation_failed');
    expect(result.incident.decision).toBe('fix_pr');
    expect(result.incident.evidence.join(' ')).toContain('already recorded');
    expect(calls.rollback).toBe(0);
  });

  it('does not start a second sandbox while a repository comment is still required', async () => {
    let fixes = 0;
    const { implementation } = provider();
    const options = makeOptions(implementation, {
      actions: { remediate: async () => { fixes += 1; return { ok: true, message: 'should not run' }; } },
    });
    await options.store.save({
      id: incidentId(projectId, current.id, '/api/tasks'),
      kind: 'runtime_regression',
      status: 'needs_human',
      detectedAt: at.toISOString(),
      projectId,
      deploymentId: current.id,
      commitSha: current.commitSha,
      probePath: '/api/tasks',
      decision: 'fix_pr',
      evidence: [],
      events: [
        { at: at.toISOString(), type: 'remediation_started', message: 'Dispatching bounded fix-PR remediation.' },
        { at: at.toISOString(), type: 'awaiting_comment', message: 'Waiting for a comment on issue #12 before writing the fix. sandbox=sb123' },
      ],
    });
    const result = await driveFailure(options);
    expect(result.action).toBe('incident');
    expect(fixes).toBe(0);
  });

  it('rolls back after a verified fix only when the current route fails and the previous deployment passes', async () => {
    const passing = provider();
    const options = makeOptions(passing.implementation, { allowlistedProjectIds: new Set() });
    const incident = {
      id: 'inc-proof', kind: 'runtime_regression' as const, status: 'remediating' as const,
      detectedAt: at.toISOString(), projectId, deploymentId: current.id, probePath: '/api/tasks',
      commitSha: current.commitSha, evidence: [] as string[], events: [] as { at: string; type: string; message: string }[],
    };
    await applyRemediationOutcome(incident, {
      ok: true, kind: 'fix', verifiedRegression: true, sandboxId: 'sb1', issueNumber: 4,
      actionUrl: 'https://github.com/iotserver24/final-devhost/pull/9',
      message: 'Verified patch published',
    }, options);
    expect(passing.calls.rollback).toBe(1);
    expect(incident.events.map(event => event.type)).toContain('rollback_completed');
    expect(incident.events.map(event => event.type)).toContain('cold');

    const failingPrevious = provider({ probeImmutableDeployment: async () => probe('fail') });
    const skipped = {
      ...incident,
      id: 'inc-proof-old',
      events: [] as { at: string; type: string; message: string }[],
      evidence: [] as string[],
    };
    await applyRemediationOutcome(skipped, {
      ok: true, kind: 'fix', verifiedRegression: true, sandboxId: 'sb2', issueNumber: 4,
      actionUrl: 'https://github.com/iotserver24/final-devhost/pull/10',
      message: 'Verified patch published',
    }, makeOptions(failingPrevious.implementation));
    expect(failingPrevious.calls.rollback).toBe(0);
    expect(skipped.events.map(event => event.type)).toContain('rollback_skipped');

    const unverified = provider();
    await applyRemediationOutcome({ ...incident, id: 'inc-plain', events: [], evidence: [] }, {
      ok: true, message: 'Fix prepared',
    }, makeOptions(unverified.implementation));
    expect(unverified.calls.rollback).toBe(0);
  });
});
