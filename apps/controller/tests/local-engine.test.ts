import { describe, expect, test } from 'bun:test';
import type { Incident, ServiceStatus } from '@nexathon/contracts';
import type { IncidentStore } from '../src/incident-store';
import { startLocalEngine } from '../src/local-engine';

/** In-memory store double matching the IncidentStore surface the engine uses. */
function memoryStore(): Pick<IncidentStore, 'get' | 'save'> & { all: Map<string, Incident> } {
  const all = new Map<string, Incident>();
  return {
    all,
    get: async id => (all.has(id) ? structuredClone(all.get(id)!) : undefined),
    save: async incident => { all.set(incident.id, structuredClone(incident)); },
  };
}

const at = '2026-01-01T00:00:00Z';

function status(serviceId: string, health: ServiceStatus['health'], detail?: string): ServiceStatus {
  return { serviceId: serviceId as ServiceStatus['serviceId'], health, checkedAt: at, ...(detail ? { detail } : {}) };
}

interface DemoOptions {
  brokenServices: ServiceStatus[];
  journeyDetail: string;
  /** Journey result before any healing action; defaults to failing. */
  journeyOk?: boolean;
  knownGoodRevision?: string;
  knownGoodConfig?: Record<string, string>;
  faultInjectedAt?: string;
  /** When set, the named action heals the stub: statuses/journey return healthy afterwards. */
  healOn?: 'restart' | 'restore-revision' | 'restore-config';
  failAction?: boolean;
}

function demoServer(options: DemoOptions): { url: string; close(): Promise<void>; actions: string[] } {
  const actions: string[] = [];
  let healed = false;
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === '/api/demo/services') {
        return Response.json({ services: healed ? [status('frontend', 'healthy'), status('task-api', 'healthy'), status('dependency', 'healthy')] : options.brokenServices });
      }
      if (url.pathname === '/api/demo/state') {
        return Response.json({
          ...(options.faultInjectedAt ? { faultInjectedAt: options.faultInjectedAt } : {}),
          ...(options.knownGoodRevision ? { knownGoodRevision: options.knownGoodRevision } : {}),
          ...(options.knownGoodConfig ? { knownGoodConfig: options.knownGoodConfig } : {}),
        });
      }
      if (url.pathname === '/api/demo/journey') {
        return Response.json({ ok: healed || options.journeyOk === true, detail: healed || options.journeyOk ? 'tasks listed' : options.journeyDetail });
      }
      if (url.pathname.startsWith('/api/demo/actions/')) {
        actions.push(url.pathname);
        if (options.failAction) return Response.json({ error: 'injected' }, { status: 500 });
        if (options.healOn && url.pathname.endsWith(options.healOn)) healed = true;
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true), actions };
}

const allHealthy = [status('frontend', 'healthy'), status('task-api', 'healthy'), status('dependency', 'healthy')];
const waitNone = async () => undefined;

async function runOnePoll(options: Omit<Parameters<typeof startLocalEngine>[0], 'wait' | 'pollIntervalMs'>, store: ReturnType<typeof memoryStore>): Promise<Incident | undefined> {
  const engine = startLocalEngine({ ...options, wait: waitNone, pollIntervalMs: 1_000_000 });
  await engine.pollNow();
  await engine.stop();
  return [...store.all.values()].at(-1);
}

describe('local incident engine', () => {
  test('healthy stack records no incident', async () => {
    const demo = demoServer({ brokenServices: allHealthy, journeyOk: true, journeyDetail: 'tasks listed' });
    const store = memoryStore();
    try {
      await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(store.all.size).toBe(0);
      expect(demo.actions).toEqual([]);
    } finally {
      await demo.close();
    }
  });

  test('failing dependency is diagnosed and restarted, then verification passes', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'dependency connection refused'), status('dependency', 'unhealthy', 'container stopped')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: 'task API reports dependency error', healOn: 'restart' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident).toBeDefined();
      expect(incident!.kind).toBe('dependency_failure');
      expect(incident!.decision).toBe('restart_service');
      expect(incident!.status).toBe('recovered');
      expect(demo.actions.some(action => action.includes('/api/demo/actions/restart'))).toBe(true);
      expect(incident!.verification?.passed).toBe(true);
      expect(incident!.timing?.verifiedRecoveryAt).toBeString();
      expect(incident!.actions?.[0]?.attempt).toBe(1);
    } finally {
      await demo.close();
    }
  });

  test('bad deployment restores the known-good revision once', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'health probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500 on /api/tasks', knownGoodRevision: 'rev-good-1', faultInjectedAt: '2026-01-01T00:00:00Z', healOn: 'restore-revision' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.kind).toBe('runtime_regression');
      expect(incident!.decision).toBe('restore_revision');
      expect(incident!.status).toBe('recovered');
      expect(demo.actions.filter(action => action.includes('restore-revision'))).toHaveLength(1);
      expect(incident!.timing?.faultInjectedAt).toBe('2026-01-01T00:00:00Z');
    } finally {
      await demo.close();
    }
  });

  test('resource exhaustion restarts the affected service', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'OOMKilled: memory limit exceeded'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: 'tasks unavailable', knownGoodRevision: 'rev-1', healOn: 'restart' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.kind).toBe('resource_exhaustion');
      expect(incident!.decision).toBe('restart_service');
      expect(incident!.status).toBe('recovered');
      expect(demo.actions.some(action => action.includes('restart'))).toBe(true);
    } finally {
      await demo.close();
    }
  });

  test('broken config is restored from the published known-good value', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'healthy', 'config flag invalid'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: 'config validation rejected max_tasks', knownGoodConfig: { max_tasks: '100' }, healOn: 'restore-config' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.kind).toBe('config_drift');
      expect(incident!.decision).toBe('restore_config');
      expect(incident!.status).toBe('recovered');
      expect(demo.actions.some(action => action.includes('restore-config'))).toBe(true);
    } finally {
      await demo.close();
    }
  });

  test('conflicting evidence escalates without mutating', async () => {
    // Every service healthy but the journey fails with no recognizable signal: must not act.
    const demo = demoServer({ brokenServices: allHealthy, journeyOk: false, journeyDetail: 'timeout on summary' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.status).toBe('needs_human');
      expect(incident!.decision).toBe('escalate');
      expect(incident!.escalation?.reason).toContain('conflicting');
      expect(incident!.escalation?.recommendedNextStep).toBeString();
      expect(demo.actions).toEqual([]);
    } finally {
      await demo.close();
    }
  });

  test('missing known-good state escalates instead of blind revert', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.status).toBe('needs_human');
      expect(demo.actions).toEqual([]);
    } finally {
      await demo.close();
    }
  });

  test('failed verification escalates and does not claim recovery', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    // No healOn: the action runs but the stub stays broken, so verification must fail honestly.
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500', knownGoodRevision: 'rev-1' });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.status).toBe('needs_human');
      expect(incident!.verification?.passed).toBe(false);
      expect(incident!.timing?.verifiedRecoveryAt).toBeUndefined();
      expect(demo.actions.filter(action => action.includes('restore-revision'))).toHaveLength(1);
    } finally {
      await demo.close();
    }
  });

  test('action execution failure escalates without retry', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500', knownGoodRevision: 'rev-1', failAction: true });
    const store = memoryStore();
    try {
      const incident = await runOnePoll({ demoBaseUrl: demo.url, store }, store);
      expect(incident!.status).toBe('needs_human');
      expect(incident!.escalation?.reason).toContain('execution failed');
      expect(incident!.actions?.[0]?.executionResult).toBe('failed');
      expect(demo.actions).toHaveLength(1);
    } finally {
      await demo.close();
    }
  });

  test('policy denial escalates with a reason and no execution', async () => {
    // The engine proposes the published known-good revision, so a mismatch can only
    // come from the broker's own ledger: simulate by consuming the attempt first.
    // The pre-warm execute reaches the demo API once; the ENGINE must make no calls.
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500', knownGoodRevision: 'rev-1' });
    const store = memoryStore();
    try {
      const engine = startLocalEngine({ demoBaseUrl: demo.url, store, wait: waitNone, pollIntervalMs: 1_000_000 });
      const incidentId = 'inc-local-runtime_regression-task-api';
      await engine.broker.execute({ kind: 'restore_revision', target: 'task-api', revision: 'rev-1' }, incidentId);
      const callsBeforeEngine = demo.actions.length;
      await engine.pollNow();
      await engine.stop();
      const incident = [...store.all.values()].at(-1)!;
      expect(incident.status).toBe('needs_human');
      expect(incident.escalation?.reason).toContain('Policy denied');
      expect(incident.actions?.[0]?.policyResult).toBe('denied');
      expect(demo.actions.length).toBe(callsBeforeEngine);
    } finally {
      await demo.close();
    }
  });

  test('detection threshold delays action until consecutive failures accumulate', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500', knownGoodRevision: 'rev-1' });
    const store = memoryStore();
    try {
      const engine = startLocalEngine({ demoBaseUrl: demo.url, store, detectionThreshold: 2, wait: waitNone, pollIntervalMs: 1_000_000 });
      await engine.pollNow();
      expect(store.all.size).toBe(0);
      await engine.pollNow();
      await engine.stop();
      expect(store.all.size).toBe(1);
    } finally {
      await demo.close();
    }
  });

  test('recovered incidents are not re-handled on later polls', async () => {
    const broken = [status('frontend', 'healthy'), status('task-api', 'unhealthy', 'probe 500'), status('dependency', 'healthy')];
    const demo = demoServer({ brokenServices: broken, journeyDetail: '500', knownGoodRevision: 'rev-1', healOn: 'restore-revision' });
    const store = memoryStore();
    try {
      const engine = startLocalEngine({ demoBaseUrl: demo.url, store, wait: waitNone, pollIntervalMs: 1_000_000 });
      await engine.pollNow();
      const first = [...store.all.values()].at(-1)!;
      expect(first.status).toBe('recovered');
      await engine.pollNow();
      await engine.stop();
      const second = store.all.get(first.id)!;
      expect(second.events.filter(item => item.type === 'action_started')).toHaveLength(1);
    } finally {
      await demo.close();
    }
  });
});
