import { describe, expect, it } from 'bun:test';
import type { Incident } from '@nexathon/contracts';
import { ActivityHub } from '../src/activity';
import { createActivityApi } from '../src/activity-api';
import { IncidentStore } from '../src/incident-store';

const incident: Incident = {
  id: 'incident-1',
  kind: 'persistent_defect',
  status: 'remediating',
  detectedAt: '2026-10-23T12:00:00.000Z',
  projectId: 'sample-project',
  commitSha: 'a'.repeat(40),
  evidence: ['Current and previous deployments fail the same probe.'],
  events: [],
};

const TOKEN = 'local-run-token-for-tests';

function api(options: { token?: string; aiConfigured?: boolean } = {}) {
  const hub = new ActivityHub();
  const handler = createActivityApi({
    hub,
    lookupIncident: id => (id === incident.id ? incident : undefined),
    dispatch: (runId, _incident, source) => {
      hub.append(runId, { at: '2026-10-23T12:00:01.000Z', phase: 'sandbox', kind: 'stage', message: `${source} started` });
    },
    token: 'token' in options ? options.token : TOKEN,
    aiConfigured: options.aiConfigured ?? false,
  });
  return { hub, handler };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://127.0.0.1/api/internal/agent-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers },
    body: JSON.stringify(body),
  });
}

describe('activity hub', () => {
  it('numbers events, replays after a sequence number and stops at completion', () => {
    const hub = new ActivityHub();
    const run = hub.create({ incidentId: incident.id, source: 'rehearsal' });
    for (let index = 0; index < 3; index++) {
      hub.append(run.id, { at: new Date().toISOString(), phase: 'agent', kind: 'tool', message: `step ${index}` });
    }
    expect(hub.get(run.id)?.events.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(hub.get(run.id, 2)?.events.map(event => event.message)).toEqual(['step 2']);

    const received: string[] = [];
    hub.subscribe(run.id, 1, event => received.push(event.message));
    expect(received).toEqual(['step 1', 'step 2']);
  });

  it('writes the run and reads it back after the memory hub is gone', async () => {
    const store = new IncidentStore(':memory:');
    const hub = new ActivityHub({
      saveRun: run => { void store.saveAgentRun(run); },
      saveEvent: (runId, event) => { void store.saveAgentEvent(runId, event); },
    });
    const run = hub.create({ incidentId: incident.id, source: 'ai' });
    hub.append(run.id, { at: '2026-10-23T12:00:02.000Z', phase: 'agent', kind: 'message', message: 'Reading the failing route.' });
    hub.finish(run.id, 'completed', 'Open pull request published.');
    const saved = await store.getAgentRun(run.id);
    expect(saved?.status).toBe('completed');
    expect(saved?.events.map(event => event.message)).toContain('Reading the failing route.');
    const restarted = new ActivityHub();
    const listed = await store.listAgentRuns();
    expect(listed.map(item => item.id)).toContain(run.id);
    const loaded = await store.getAgentRun(run.id);
    restarted.restore({ ...loaded!, events: loaded!.events.map(event => ({ ...event, phase: 'agent', kind: 'message' })) });
    expect(restarted.get(run.id)?.events.length).toBeGreaterThan(0);
  });

  it('persists detailed output beyond the old 1000-character cap with secrets redacted', async () => {
    const store = new IncidentStore(':memory:');
    const hub = new ActivityHub({
      saveRun: run => { void store.saveAgentRun(run); },
      saveEvent: (runId, event) => { void store.saveAgentEvent(runId, event); },
    });
    const run = hub.create({ incidentId: incident.id, source: 'ai' });
    hub.append(run.id, { at: new Date().toISOString(), phase: 'agent', kind: 'tool_output', message: `Test output\npassword=hidden\n${'x'.repeat(8000)}output-end` });
    const saved = await store.getAgentRun(run.id);
    expect(saved?.events[0]?.message).toContain('output-end');
    expect(saved?.events[0]?.message).not.toContain('password=hidden');
    expect(saved?.events[0]?.kind).toBe('tool_output');
  });

  it('keeps only the newest runs and marks an active run', () => {
    const hub = new ActivityHub();
    for (let index = 0; index < 25; index++) hub.create({ incidentId: incident.id, source: 'rehearsal' });
    expect(hub.list()).toHaveLength(20);
    expect(hub.hasActiveRun()).toBe(true);
  });
});

describe('activity API', () => {
  it('refuses to start a run without the local token or from a browser origin', async () => {
    const { handler } = api();
    expect((await handler(post({ incidentId: incident.id, mode: 'rehearsal' }, { Authorization: 'Bearer wrong' })))!.status).toBe(403);
    expect((await handler(post({ incidentId: incident.id, mode: 'rehearsal' }, { Origin: 'https://malicious.example' })))!.status).toBe(403);
    expect((await handler(post({ incidentId: incident.id, mode: 'rehearsal' }, { 'Content-Type': 'text/plain' })))!.status).toBe(415);
  });

  it('starts a labeled rehearsal and streams its events', async () => {
    const { handler, hub } = api();
    const started = await handler(post({ incidentId: incident.id, mode: 'rehearsal' }));
    expect(started!.status).toBe(202);
    const run = await started!.json() as { id: string; source: string };
    expect(run.source).toBe('rehearsal');
    expect(hub.hasActiveRun()).toBe(true);

    const stream = await handler(new Request(`http://127.0.0.1/api/agent/runs/${run.id}/events`));
    expect(stream!.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream!.body!.getReader();
    try {
      const chunk = await Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error('SSE timed out'); })]);
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain('event: activity');
      expect(text).toContain('rehearsal started');
    } finally {
      await reader.cancel();
    }
  });

  it('rejects an AI run while remediation is unconfigured', async () => {
    const { handler } = api({ aiConfigured: false });
    expect((await handler(post({ incidentId: incident.id, mode: 'ai' })))!.status).toBe(503);
  });

  it('bounds input and rejects unknown incidents or runs', async () => {
    const { handler } = api();
    expect((await handler(post({ incidentId: 'missing', mode: 'rehearsal' })))!.status).toBe(404);
    expect((await handler(post({ incidentId: incident.id, mode: 'production' })))!.status).toBe(400);
    expect((await handler(post({ incidentId: '../etc', mode: 'rehearsal' })))!.status).toBe(400);
    expect((await handler(new Request('http://127.0.0.1/api/agent/runs/run-missing/events')))!.status).toBe(404);
    expect((await handler(new Request('http://127.0.0.1/api/internal/agent-runs')))!.status).toBe(405);
    expect(await handler(new Request(`http://127.0.0.1/api/incidents/${incident.id}`))).toBeUndefined();
  });

  it('refuses a second concurrent run', async () => {
    const { handler } = api();
    expect((await handler(post({ incidentId: incident.id, mode: 'rehearsal' })))!.status).toBe(202);
    expect((await handler(post({ incidentId: incident.id, mode: 'rehearsal' })))!.status).toBe(409);
  });
});
