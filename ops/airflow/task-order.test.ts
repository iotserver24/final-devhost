import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

const source = readFileSync(new URL('./dags/sentinel_incident.py', import.meta.url), 'utf8');

const order = [
  'probe',
  'classify',
  'notify',
  'diagnose_and_open_issue',
  'wait_for_owner_comment',
  'fix_after_comment',
  'verify',
  'open_pull_request',
  'pause',
];

test('the incident DAG names the controller steps in order and does not remediate', () => {
  const listed = [...source.matchAll(/"([a-z_]+)"/g)].map(match => match[1]);
  const steps = order.map(step => listed.indexOf(step));
  expect(steps.every(index => index >= 0)).toBe(true);
  expect([...steps].sort((left, right) => left - right)).toEqual(steps);
  expect(source).toContain('method="GET"');
  expect(source).not.toContain('method="POST"');
  expect(source).not.toContain('/api/sites/break');
  expect(source).not.toContain('inc-914');
  expect(source).not.toContain('gh pr merge');
});
