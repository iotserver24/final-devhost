import { describe, expect, test } from 'bun:test';
import { parseTargets, targetsFromEnvironment } from '../src/targets';

const httpTarget = (id: string, url = 'https://example.test') => ({
  id, name: id, kind: 'http', provider: 'vercel', url, probePath: '/api/tasks',
  criticalRoutes: ['/api/health'], rollback: { enabled: true, maxAttempts: 1 },
});

describe('multi-target configuration', () => {
  test('parses two independent targets', () => {
    const { targets, problems } = parseTargets([httpTarget('alpha'), httpTarget('beta', 'https://beta.test')]);
    expect(problems).toEqual([]);
    expect(targets).toHaveLength(2);
    expect(targets[0]!.id).toBe('alpha');
    expect(targets[1]!.url).toBe('https://beta.test');
    expect(targets.every(target => target.rollback?.enabled === true)).toBe(true);
  });

  test('a broken target is dropped without losing the healthy one', () => {
    const { targets, problems } = parseTargets([
      httpTarget('alpha'),
      { id: 'broken', kind: 'http', url: 'http://not-local.example.test' },
    ]);
    expect(targets.map(target => target.id)).toEqual(['alpha']);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('plain HTTP');
  });

  test('duplicate and unsafe ids are rejected', () => {
    const { targets, problems } = parseTargets([httpTarget('alpha'), httpTarget('alpha'), { id: '../etc', kind: 'http', url: 'https://x.test' }]);
    expect(targets).toHaveLength(1);
    expect(problems.some(problem => problem.includes('duplicate'))).toBe(true);
    expect(problems.some(problem => problem.includes('id must match'))).toBe(true);
  });

  test('vm targets require an agent URL and a safe application name', () => {
    const good = parseTargets([{ id: 'vm-one', kind: 'vm', vm: { agentUrl: 'https://vm.test', application: 'taskflow', healthPath: '/health' } }]);
    expect(good.problems).toEqual([]);
    expect(good.targets[0]!.vm?.application).toBe('taskflow');

    const bad = parseTargets([{ id: 'vm-two', kind: 'vm', vm: { agentUrl: 'https://vm.test', application: 'rm -rf /' } }]);
    expect(bad.targets).toHaveLength(0);
    expect(bad.problems.join(' ')).toContain('application');
  });

  test('rollback policy defaults to disabled with one attempt', () => {
    const { targets } = parseTargets([{ id: 'plain', kind: 'http', url: 'https://plain.test' }]);
    expect(targets[0]!.rollback).toEqual({ enabled: false, maxAttempts: 1 });
  });

  test('per-target thresholds and notification labels are preserved', () => {
    const { targets } = parseTargets([{ ...httpTarget('alpha'), failureThreshold: 5, notify: 'oncall-alpha' }]);
    expect(targets[0]!.failureThreshold).toBe(5);
    expect(targets[0]!.notify).toBe('oncall-alpha');
  });

  test('non-array input is reported, not thrown', () => {
    expect(parseTargets({}).problems[0]).toContain('array');
  });
});

describe('targetsFromEnvironment', () => {
  test('parses CONTROLLER_TARGETS JSON', () => {
    const { targets, problems } = targetsFromEnvironment({ CONTROLLER_TARGETS: JSON.stringify([httpTarget('alpha'), httpTarget('beta')]) });
    expect(problems).toEqual([]);
    expect(targets).toHaveLength(2);
  });

  test('malformed JSON yields a problem and no targets', () => {
    const { targets, problems } = targetsFromEnvironment({ CONTROLLER_TARGETS: '{not json' });
    expect(targets).toEqual([]);
    expect(problems[0]).toContain('not valid JSON');
  });

  test('falls back to the legacy single-target environment', () => {
    const { targets } = targetsFromEnvironment({ VERCEL_PRODUCTION_DOMAIN: 'app.example.test', CONTROLLER_PROBE_PATH: '/api/tasks' });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.id).toBe('primary');
    expect(targets[0]!.url).toBe('https://app.example.test');
    expect(targets[0]!.probePath).toBe('/api/tasks');
  });

  test('no configuration yields no targets and no problems', () => {
    expect(targetsFromEnvironment({})).toEqual({ targets: [], problems: [] });
  });
});