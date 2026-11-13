import { describe, expect, it } from 'bun:test';
import { createControllerActions, resumeRemediation } from '../src/actions';
import type { Incident } from '@nexathon/contracts';

const incident: Incident = {
  id: 'inc-test', kind: 'persistent_defect', status: 'remediating', detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  evidence: ['Failure'], events: [],
};

describe('controller actions', () => {
  it('records Slack configuration failures without throwing', async () => {
    const actions = createControllerActions({ slackWebhookUrl: 'https://example.com/not-slack' });
    const result = await actions.notify!(incident);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Slack webhook is invalid');
  });

  it('refuses remediation when the incident has no trusted commit SHA', async () => {
    const savedToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'test-write';
    let issueOpened = false;
    try {
      const actions = createControllerActions({ remediation: {
        repository: 'iotserver24/nexathon', setupCommand: 'bun install', reproduceCommand: 'bun test',
        testCommand: 'bun test', buildCommand: 'bun run build',
        provider: { modelName: 'model', modelId: 'id', baseUrl: 'https://provider.example/v1', apiBackend: 'responses', apiKey: 'secret', githubReadToken: 'read-only' },
      } }, undefined, {
        credentials: async () => ({}),
        openIssue: async () => { issueOpened = true; return { number: 42, url: 'https://github.com/iotserver24/nexathon/issues/42' }; },
        updateIssue: async () => {}, commentIssue: async () => {},
        generateFix: async () => { throw new Error('Sandbox must not run without a revision'); },
        publishPr: async () => { throw new Error('PR must not be created without a revision'); },
      });
      const result = await actions.remediate!({ ...incident, events: [] });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('no commit SHA');
      expect(issueOpened).toBe(true);
    } finally {
      if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    }
  });
});

describe('issue-first remediation', () => {
  const config = {
    repository: 'iotserver24/nexathon', setupCommand: 'bun install', reproduceCommand: 'bun test',
    testCommand: 'bun test', buildCommand: 'bun run build',
    provider: { modelName: 'model', modelId: 'id', baseUrl: 'https://provider.example/v1', apiBackend: 'responses' as const, apiKey: 'secret', githubReadToken: 'read-only' },
  };
  const issueUrl = 'https://github.com/iotserver24/nexathon/issues/42';
  const makeIncident = (): Incident => ({ ...incident, id: 'inc-issue-first', commitSha: 'a'.repeat(40), evidence: ['HTTP 500'], events: [] });

  it('opens and saves an issue before diagnosis, updates it, and waits for a comment', async () => {
    const { IncidentStore } = await import('../src/incident-store');
    const store = new IncidentStore(':memory:');
    const calls: string[] = [];
    const savedToken = process.env.GH_TOKEN;
    const savedReadToken = process.env.GITHUB_READ_TOKEN;
    const current = makeIncident();
    try {
      const actions = createControllerActions({ remediation: config, settings: store }, undefined, {
        credentials: async () => ({ read: 'test-read', write: 'test-write' }),
        commentIssue: async () => {},
        openIssue: async () => { calls.push('open'); return { number: 42, url: issueUrl }; },
        updateIssue: async () => { calls.push('update'); },
        generateFix: async request => {
          calls.push('diagnose');
          expect(request.issueUrl).toBe(issueUrl);
          expect((await store.get(current.id))?.actionUrl).toBe(issueUrl);
          return { ok: true, phase: 'awaiting_comment', incidentId: current.id, sandboxId: 'sandbox-42', diagnosis: 'Evidence', question: 'Choose a method', testPath: 'apps/sample/tests/incident-test.test.ts', testOutput: 'failed' };
        },
        publishPr: async () => { throw new Error('A PR cannot be published during diagnosis'); },
      });
      const result = await actions.remediate!(current);
      expect(result.ok).toBe(true);
      expect(result.kind).toBe('waiting');
      expect(result.actionUrl).toBe(issueUrl);
      expect(calls).toEqual(['open', 'diagnose', 'update']);
      await actions.remediate!(current);
      expect(calls.filter(call => call === 'open')).toHaveLength(1);
    } finally {
      if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
      if (savedReadToken === undefined) delete process.env.GITHUB_READ_TOKEN; else process.env.GITHUB_READ_TOKEN = savedReadToken;
      store.close();
    }
  });

  it('requires the matching issue and a resumed owner comment before applying a fix', async () => {
    const paused: Incident = { ...makeIncident(), events: [
      { at: '2026-10-23T12:00:00.000Z', type: 'awaiting_comment', message: 'Waiting for a comment on issue #42 before writing the fix. sandbox=sandbox-42' },
      { at: '2026-10-23T12:00:00.000Z', type: 'review_resumed', message: 'Owner comment received.' },
    ] };
    const wrongIssue = await resumeRemediation(paused, 'Apply the fix', 'sandbox-42', { number: 43, url: 'https://github.com/iotserver24/nexathon/issues/43' }, 'fix', config);
    const wrongSandbox = await resumeRemediation(paused, 'Apply the fix', 'sandbox-43', { number: 42, url: issueUrl }, 'fix', config);
    const missingComment = await resumeRemediation(paused, '', 'sandbox-42', { number: 42, url: issueUrl }, 'fix', config);
    const noResume = await resumeRemediation({ ...paused, events: paused.events.slice(0, 1) }, 'Apply the fix', 'sandbox-42', { number: 42, url: issueUrl }, 'fix', config);
    for (const result of [wrongIssue, wrongSandbox, missingComment, noResume]) {
      expect(result.ok).toBe(false);
      expect(result.message).toContain('matching incident issue and owner comment');
    }
  });

  it('publishes a PR linked to the issue only after its owner comment resumes the sandbox', async () => {
    const paused: Incident = { ...makeIncident(), events: [
      { at: '2026-10-23T12:00:00.000Z', type: 'awaiting_comment', message: 'Waiting for a comment on issue #42 before writing the fix. sandbox=sandbox-42' },
      { at: '2026-10-23T12:00:00.000Z', type: 'review_resumed', message: 'Owner comment received.' },
    ] };
    const savedToken = process.env.GH_TOKEN;
    const calls: string[] = [];
    process.env.GH_TOKEN = 'test-write';
    try {
      const result = await resumeRemediation(paused, 'Apply the fix', 'sandbox-42', { number: 42, url: issueUrl }, 'fix', config, undefined, undefined, {
        credentials: async () => ({ write: 'test-write', read: 'test-read' }),
        openIssue: async () => { throw new Error('Issue already exists'); },
        updateIssue: async () => { throw new Error('Issue already updated'); },
        generateFix: async (request, _provider, options) => {
          calls.push('fix');
          expect(request.issueUrl).toBe(issueUrl);
          expect(options?.phase).toBe('fix');
          expect(options?.comment).toBe('Apply the fix');
          return { ok: true, incidentId: paused.id, baseSha: 'a'.repeat(40), patch: 'patch', changedFiles: ['apps/sample/src/a.ts'], baseline: 'failed', agentSummary: 'fix', testOutput: 'pass', buildOutput: 'pass', mcpConfigured: true, verifiedRegression: true };
        },
        publishPr: async request => { calls.push('publish'); expect(request.issueUrl).toBe(issueUrl); return { branch: 'fix', url: 'https://github.com/iotserver24/nexathon/pull/43' }; },
        commentIssue: async () => { calls.push('comment'); },
      });
      expect(result.ok).toBe(true);
      expect(result.actionUrl).toBe('https://github.com/iotserver24/nexathon/pull/43');
      expect(calls).toEqual(['fix', 'publish', 'comment']);
    } finally {
      if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
    }
  });

  it('refuses to publish if diagnosis unexpectedly returns a patch', async () => {
    const { IncidentStore } = await import('../src/incident-store');
    const store = new IncidentStore(':memory:');
    const savedToken = process.env.GH_TOKEN;
    const savedReadToken = process.env.GITHUB_READ_TOKEN;
    let published = false;
    try {
      const actions = createControllerActions({ remediation: config, settings: store }, undefined, {
        credentials: async () => ({ read: 'test-read', write: 'test-write' }),
        commentIssue: async () => {},
        openIssue: async () => ({ number: 42, url: issueUrl }),
        updateIssue: async () => {},
        generateFix: async () => ({ ok: true, incidentId: 'inc-issue-first', baseSha: 'a'.repeat(40), patch: 'patch', changedFiles: ['apps/sample/src/a.ts'], baseline: 'failed', agentSummary: 'fix', testOutput: 'pass', buildOutput: 'pass', mcpConfigured: true }),
        publishPr: async () => { published = true; return { branch: 'fix', url: 'https://github.com/iotserver24/nexathon/pull/1' }; },
      });
      const result = await actions.remediate!(makeIncident());
      expect(result.ok).toBe(false);
      expect(result.message).toContain('no pull request was created');
      expect(published).toBe(false);
    } finally {
      if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
      if (savedReadToken === undefined) delete process.env.GITHUB_READ_TOKEN; else process.env.GITHUB_READ_TOKEN = savedReadToken;
      store.close();
    }
  });
});
