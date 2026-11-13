import { describe, expect, test } from 'bun:test';
import { incidentIssueRef } from '../src/issue-link';

describe('incident issue link', () => {
  test('reads the repository from the pull request and the issue number from the timeline', () => {
    expect(incidentIssueRef({
      actionUrl: 'https://github.com/iotserver24/final-devhost/pull/7',
      events: [{ message: 'Verified patch published. It references issue #6.' }],
    })).toEqual({ owner: 'iotserver24', repo: 'final-devhost', number: 6 });
  });

  test('prefers an issue URL over a later mention', () => {
    expect(incidentIssueRef({
      actionUrl: 'https://github.com/iotserver24/final-devhost/issues/6',
      events: [{ message: 'See issue #9' }],
    })?.number).toBe(6);
  });

  test('returns nothing when the incident names no issue', () => {
    expect(incidentIssueRef({ events: [{ message: 'Probe failed.' }] })).toBeNull();
  });
});
