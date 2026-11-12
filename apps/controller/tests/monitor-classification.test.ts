import { describe, expect, test } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { checkProject, type Deployment, type DeploymentProvider, type ProbeResponse } from '../src/monitor';

const projectId = 'classify-project';
const at = new Date('2026-03-01T12:00:00.000Z');
const current: Deployment = {
  id: 'deploy-current',
  immutableUrl: 'https://current-abc123.vercel.app',
  createdAt: '2026-03-01T11:59:00.000Z',
  commitSha: 'a'.repeat(40),
};
const previous: Deployment = {
  id: 'deploy-previous',
  immutableUrl: 'https://previous-def456.vercel.app',
  createdAt: '2026-03-01T11:00:00.000Z',
  commitSha: 'b'.repeat(40),
};

function provider(statusForCurrent: () => ProbeResponse): { implementation: DeploymentProvider; rollbacks: () => number } {
  let rollbacks = 0;
  const implementation: DeploymentProvider = {
    async getProductionDeployment() { return current; },
    async getPreviousDeployment() { return previous; },
    async probeImmutableDeployment() { return { result: 'pass', statusCode: 200, evidence: 'HTTP 200' }; },
    async probeProduction() { return statusForCurrent(); },
    async rollbackProductionTo() { rollbacks += 1; return { actionUrl: previous.immutableUrl }; },
  };
  return { implementation, rollbacks: () => rollbacks };
}

function store() {
  return new IncidentStore(':memory:');
}

/** Run three consecutive checks so the failure streak is satisfied. */
async function runChecks(
  incidentStore: IncidentStore,
  implementation: DeploymentProvider,
  probePath = '/api/tasks',
) {
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(await checkProject({
      projectId,
      allowlistedProjectIds: new Set([projectId]),
      probePath,
      provider: implementation,
      store: incidentStore,
      now: () => at,
    }));
  }
  return results;
}

describe('monitor HTTP classification gate', () => {
  test('a normal 404 never creates an incident or rolls back', async () => {
    const incidentStore = store();
    const { implementation, rollbacks } = provider(() => ({ result: 'fail', statusCode: 404, evidence: 'HTTP 404' }));
    const results = await runChecks(incidentStore, implementation);
    expect(results.every(result => result.action === 'monitor')).toBe(true);
    expect(await incidentStore.list()).toHaveLength(0);
    expect(rollbacks()).toBe(0);
  });

  test('a 404 on a critical route is classified and becomes an incident', async () => {
    const incidentStore = store();
    const { implementation } = provider(() => ({ result: 'fail', statusCode: 404, evidence: 'HTTP 404' }));
    const results = await runChecks(incidentStore, implementation, '/api/health');
    const incident = results.find(result => result.action === 'incident');
    expect(incident).toBeDefined();
    const saved = (await incidentStore.list())[0]!;
    expect(saved.classification).toBe('incident');
    expect(saved.evidence.some(line => line.includes('classification'))).toBe(true);
  });

  test('repeated 5xx on the probe route becomes an incident after the failure threshold', async () => {
    const incidentStore = store();
    // Only one observation: streak is 1, below the three-failure rule anyway.
    const { implementation } = provider(() => ({ result: 'fail', statusCode: 503, evidence: 'HTTP 503' }));
    const results = await runChecks(incidentStore, implementation);
    // Streak reaches 3 with statusCode present, so classification escalates to incident.
    const incident = results.find(result => result.action === 'incident');
    expect(incident).toBeDefined();
    expect((await incidentStore.list())[0]!.classification).toBe('incident');
  });

  test('a repeated 401 on a critical route is an incident; on a normal route it is not', async () => {
    const criticalStore = store();
    const critical = provider(() => ({ result: 'fail', statusCode: 401, evidence: 'HTTP 401' }));
    const criticalResults = await runChecks(criticalStore, critical.implementation, '/api/health');
    expect(criticalResults.some(result => result.action === 'incident')).toBe(true);

    const normalStore = store();
    const normal = provider(() => ({ result: 'fail', statusCode: 401, evidence: 'HTTP 401' }));
    const normalResults = await runChecks(normalStore, normal.implementation, '/public/feed');
    expect(normalResults.every(result => result.action === 'monitor')).toBe(true);
    expect(await normalStore.list()).toHaveLength(0);
  });

  test('a probe with no status code keeps the previous behaviour (actionable)', async () => {
    const incidentStore = store();
    const { implementation } = provider(() => ({ result: 'fail', evidence: 'Connection reset before response' }));
    const results = await runChecks(incidentStore, implementation);
    expect(results.some(result => result.action === 'incident')).toBe(true);
  });

  test('operator-configured policy changes the outcome', async () => {
    const incidentStore = store();
    const { implementation } = provider(() => ({ result: 'fail', statusCode: 404, evidence: 'HTTP 404' }));
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(await checkProject({
        projectId,
        allowlistedProjectIds: new Set([projectId]),
        probePath: '/api/tasks',
        provider: implementation,
        store: incidentStore,
        now: () => at,
        classificationPolicy: {
          ignoredStatuses: [],
          warningStatuses: [],
          incidentStatuses: [404],
          criticalRoutes: ['/api/tasks'],
          repeatThreshold: 3,
          notFoundSpikeMultiplier: 5,
          notFoundSpikeFloor: 10,
        },
      }));
    }
    expect(results.some(result => result.action === 'incident')).toBe(true);
  });
});