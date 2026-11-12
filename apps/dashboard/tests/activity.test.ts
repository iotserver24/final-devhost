import { expect, test } from 'bun:test';
import { parseActivityEvent, parseActivityRuns } from '../src/activity';

test('accepts a well-formed run list and ignores unusable events', () => {
  const runs = parseActivityRuns([{
    id: 'run-abc123', incidentId: 'incident-1', source: 'rehearsal', status: 'running',
    startedAt: '2026-10-23T12:00:00.000Z', eventCount: 3,
  }]);
  expect(runs[0]).toMatchObject({ id: 'run-abc123', source: 'rehearsal', status: 'running' });
  expect(parseActivityEvent({ seq: 1, at: '2026-10-23T12:00:01.000Z', phase: 'agent', kind: 'tool', message: 'Running read_file' }))
    .toMatchObject({ seq: 1, phase: 'agent', message: 'Running read_file' });
  expect(parseActivityEvent({ seq: 0, at: '2026-10-23T12:00:01.000Z', phase: 'agent', kind: 'tool', message: 'x' })).toBeNull();
  expect(parseActivityEvent({ seq: 1, at: 'not a date', phase: 'agent', kind: 'tool', message: 'x' })).toBeNull();
  expect(parseActivityEvent({ seq: 1, at: '2026-10-23T12:00:01.000Z', phase: 'thought', kind: 'tool', message: 'x' })).toBeNull();
});

test('redacts credentials that reach the feed and rejects unknown run states', () => {
  // Assembled at runtime so the repository contains no secret-shaped literal.
  const fakeKey = ['sk', 'placeholder', 'placeholder'].join('-');
  const event = parseActivityEvent({
    seq: 2, at: '2026-10-23T12:00:02.000Z', phase: 'patch', kind: 'status',
    message: `Authorization: Bearer ${fakeKey}`,
  });
  expect(event?.message).not.toContain(fakeKey);
  expect(() => parseActivityRuns([{ id: 'run-1', incidentId: 'i', source: 'shell', status: 'running', startedAt: '2026-10-23T12:00:00.000Z', eventCount: 0 }]))
    .toThrow();
});

 test('preserves long transcript details and accepts the new message categories', () => {
  for (const kind of ['tool_input', 'tool_output', 'summary']) {
    const event = parseActivityEvent({ seq: 1, at: '2026-10-23T12:00:01Z', phase: 'agent', kind,
      message: 'x'.repeat(8000) + 'output-end' });
    expect(event?.message).toEndWith('output-end');
  }
});
