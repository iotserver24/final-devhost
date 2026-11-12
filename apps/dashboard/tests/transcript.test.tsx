import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentTranscript } from '../src/AgentTranscript';
import type { ActivityRun, ActivityEvent } from '../src/activity';

test('renders expandable tool details, complete messages, and downloadable run history as escaped text', () => {
  const run: ActivityRun = { id: 'run-test', incidentId: 'inc-test', source: 'ai', status: 'completed', startedAt: '2026-10-24T00:00:00Z', eventCount: 3 };
  const events: ActivityEvent[] = [
    { seq: 1, at: run.startedAt, phase: 'agent', kind: 'message', message: 'Source diagnosis ' + 'x'.repeat(3000) + 'message-end' },
    { seq: 2, at: run.startedAt, phase: 'agent', kind: 'tool_output', message: 'read_file completed\n<script>alert(1)</script>\nexport const route = true;' },
    { seq: 3, at: run.startedAt, phase: 'patch', kind: 'summary', message: 'Fixed the route. Tests passed.' },
  ];
  const html = renderToStaticMarkup(<AgentTranscript events={events} run={run} />);
  expect(html).toContain('message-end');
  expect(html).toContain('<details');
  expect(html).toContain('Download transcript');
  expect(html).toContain('Follow latest');
  expect(html).toContain('Fixed the route. Tests passed.');
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});
