import { describe, expect, test } from 'bun:test';
import { incidentActionLabel } from '../src/incident-action';

describe('incident action labels', () => {
  test('labels an issue, PR, and rollback target by their actual destinations', () => {
    expect(incidentActionLabel('https://github.com/team/repo/issues/42', true)).toBe('Open GitHub issue');
    expect(incidentActionLabel('https://github.com/team/repo/pull/43', true)).toBe('Open pull request');
    expect(incidentActionLabel('https://app-previous.vercel.app', true)).toBe('View rollback target');
    expect(incidentActionLabel('https://example.com/pull/43', false)).toBe('View action');
  });
});
