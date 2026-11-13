import { describe, expect, test } from 'bun:test';
import { ActionBroker, type DemoEnvironment, type KnownGoodState } from '../src/broker';
import type { BrokerRequest } from '@nexathon/contracts';

function stubEnvironment(overrides: Partial<KnownGoodState> = {}): DemoEnvironment & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    knownGood: async () => ({
      revision: 'rev-good-1',
      configValues: new Map([['max_tasks', '100']]),
      ...overrides,
    }),
    restoreRevision: async revision => { calls.push(`restoreRevision:${revision}`); },
    restoreConfig: async (key, value) => { calls.push(`restoreConfig:${key}=${value}`); },
    restartService: async serviceId => { calls.push(`restartService:${serviceId}`); },
  };
}

const goodRevision: BrokerRequest = { kind: 'restore_revision', target: 'task-api', revision: 'rev-good-1' };
const goodConfig: BrokerRequest = { kind: 'restore_config', target: 'task-api', configKey: 'max_tasks', configValue: '100' };
const goodRestart: BrokerRequest = { kind: 'restart_service', target: 'dependency' };

describe('ActionBroker', () => {
  test('allows allowlisted requests matching known-good state', async () => {
    const env = stubEnvironment();
    const broker = new ActionBroker(env);
    for (const request of [goodRevision, goodConfig, goodRestart]) {
      const decision = await broker.evaluate(request, 'inc-1', false);
      expect(decision.allowed).toBe(true);
    }
    expect(env.calls).toEqual([]);
  });

  test('rejects targets outside the allowlist', async () => {
    const broker = new ActionBroker(stubEnvironment());
    const denied = await broker.evaluate({ kind: 'restart_service', target: 'frontend' }, 'inc-1', false);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('not allowlisted');
    const hostAttempt = await broker.evaluate({ kind: 'restore_revision', target: 'host-docker' }, 'inc-1', false);
    expect(hostAttempt.allowed).toBe(false);
  });

  test('rejects revisions that are not the published known-good', async () => {
    const broker = new ActionBroker(stubEnvironment());
    const denied = await broker.evaluate({ ...goodRevision, revision: 'rev-unknown' }, 'inc-1', false);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('known-good');
  });

  test('rejects config restores without a known-good value or with a guessed value', async () => {
    const broker = new ActionBroker(stubEnvironment());
    const noKey = await broker.evaluate({ kind: 'restore_config', target: 'task-api', configKey: 'other', configValue: 'x' }, 'inc-1', false);
    expect(noKey.allowed).toBe(false);
    const wrongValue = await broker.evaluate({ ...goodConfig, configValue: '999' }, 'inc-1', false);
    expect(wrongValue.allowed).toBe(false);
  });

  test('rejects malformed parameters', async () => {
    const broker = new ActionBroker(stubEnvironment());
    expect((await broker.evaluate({ kind: 'restore_revision', target: 'task-api', revision: 'a; rm -rf /' }, 'i', false)).allowed).toBe(false);
    expect((await broker.evaluate({ kind: 'restore_revision', target: 'task-api' }, 'i', false)).allowed).toBe(false);
    expect((await broker.evaluate({ kind: 'restore_config', target: 'task-api', configKey: 'k' }, 'i', false)).allowed).toBe(false);
  });

  test('dry run evaluates the same policy without mutating or consuming the attempt', async () => {
    const env = stubEnvironment();
    const broker = new ActionBroker(env);
    const decision = await broker.dryRun(goodRevision, 'inc-1');
    expect(decision.allowed).toBe(true);
    expect(decision.dryRun).toBe(true);
    expect(env.calls).toEqual([]);
    // The real attempt is still available afterwards.
    const executed = await broker.execute(goodRevision, 'inc-1');
    expect(executed.allowed).toBe(true);
    expect(env.calls).toEqual(['restoreRevision:rev-good-1']);
  });

  test('enforces one automatic attempt per incident', async () => {
    const env = stubEnvironment();
    const broker = new ActionBroker(env);
    expect((await broker.execute(goodRevision, 'inc-1')).allowed).toBe(true);
    const second = await broker.execute(goodRevision, 'inc-1');
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain('One automatic attempt');
    expect(env.calls).toEqual(['restoreRevision:rev-good-1']);
    // A different incident still gets its own attempt.
    expect((await broker.execute(goodRevision, 'inc-2')).allowed).toBe(true);
  });

  test('records an audit entry for every request, allowed or denied', async () => {
    const broker = new ActionBroker(stubEnvironment());
    await broker.execute(goodRestart, 'inc-1');
    await broker.evaluate({ kind: 'restore_revision', target: 'dependency' }, 'inc-1', false);
    const trail = broker.auditTrail();
    expect(trail).toHaveLength(2);
    expect(trail[0]!.allowed).toBe(true);
    expect(trail[1]!.allowed).toBe(false);
    expect(trail[1]!.reason).toContain('not allowlisted');
  });

  test('reports execution failures without counting a successful attempt', async () => {
    const env = stubEnvironment();
    env.restartService = async () => { throw new Error('docker unreachable'); };
    const broker = new ActionBroker(env);
    const entry = await broker.execute(goodRestart, 'inc-1');
    expect(entry.reason).toContain('Execution failed');
    // Failed execution did not complete the attempt; retry is still possible per policy.
    expect((await broker.evaluate(goodRestart, 'inc-1', false)).allowed).toBe(true);
  });
});
