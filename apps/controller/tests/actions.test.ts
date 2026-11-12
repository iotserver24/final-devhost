import { describe, expect, it } from 'bun:test';
import { createControllerActions } from '../src/actions';
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
    const actions = createControllerActions({ remediation: {
      repository: 'iotserver24/nexathon', setupCommand: 'bun install', reproduceCommand: 'bun test',
      testCommand: 'bun test', buildCommand: 'bun run build',
      provider: { modelName: 'model', modelId: 'id', baseUrl: 'https://provider.example/v1', apiBackend: 'responses', apiKey: 'secret', githubReadToken: 'read-only' },
    } });
    const result = await actions.remediate!(incident);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no commit SHA');
  });
});
