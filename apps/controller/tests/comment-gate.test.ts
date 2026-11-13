import { describe, expect, it } from 'bun:test';
import type { Incident } from '@nexathon/contracts';
import { authorMayComment, awaitingComment, coldSandbox, planResume, readOwnerComment, retriesStoredIncident, selectFreshComments } from '../src/comment-gate';

function incident(events: Incident['events'], extra: Partial<Incident> = {}): Incident {
  return {
    id: 'inc-1',
    kind: 'runtime_regression',
    status: 'needs_human',
    detectedAt: '2026-11-13T10:00:00.000Z',
    projectId: 'prj',
    evidence: [],
    events,
    ...extra,
  };
}

const waiting = incident([
  { at: '2026-11-13T10:00:00.000Z', type: 'remediation_started', message: 'Dispatching bounded fix-PR remediation.' },
  { at: '2026-11-13T10:05:00.000Z', type: 'awaiting_comment', message: 'Waiting for a comment on issue #41 before writing the fix. sandbox=sb-paused' },
]);

describe('comment gate', () => {
  it('does not retry a public probe that was recorded without a deployment', () => {
    expect(retriesStoredIncident(incident([], { decision: 'escalate' }))).toBe(false);
    expect(retriesStoredIncident(incident([], { decision: 'fix_pr' }))).toBe(false);
    expect(retriesStoredIncident(incident([], { decision: 'fix_pr', deploymentId: 'dpl_current' }))).toBe(true);
    expect(retriesStoredIncident(waiting)).toBe(false);
  });

  it('keeps the sandbox paused until a later review resumes it', () => {
    expect(awaitingComment(waiting)).toEqual({ issueNumber: 41, sandboxId: 'sb-paused', at: '2026-11-13T10:05:00.000Z' });
    const resumed = incident([
      ...waiting.events,
      { at: '2026-11-13T10:06:00.000Z', type: 'review_resumed', message: 'Comment resumed sandbox sb-paused.' },
    ]);
    expect(awaitingComment(resumed)).toBeNull();
  });

  it('lets the repository owner comment without @sentinel and ignores the bot', () => {
    const context = { allowedRepository: 'iotserver24/final-devhost', allowedAuthors: [] as string[] };
    const payload = {
      action: 'created',
      installation: { id: 181585528 },
      repository: { full_name: 'iotserver24/final-devhost' },
      issue: { number: 41 },
      comment: { id: 7, body: 'Use the null check.', user: { login: 'iotserver24', type: 'User' } },
    };
    expect(readOwnerComment(payload, context).kind).toBe('comment');
    expect(readOwnerComment({ ...payload, comment: { id: 8, body: 'loop', user: { login: 'sentinal-ai-bot[bot]', type: 'Bot' } } }, context).kind).toBe('ignored');
    expect(authorMayComment('someone-else', 'User', 'iotserver24/final-devhost', [])).toBe(false);
    expect(authorMayComment('iotserver24', 'User', 'iotserver24/final-devhost', ['iotserver24'])).toBe(true);
  });

  it('resumes the fix from the open issue and a later reply from the pull request', () => {
    expect(planResume([waiting], { number: 41, onPullRequest: false })?.phase).toBe('fix');
    const cold = incident([
      { at: '2026-11-13T10:00:00.000Z', type: 'review_resumed', message: 'resumed' },
      { at: '2026-11-13T10:20:00.000Z', type: 'draft_pr', message: 'pull request opened' },
      { at: '2026-11-13T10:21:00.000Z', type: 'cold', message: 'Paused after the pull request. sandbox=sb-cold issue #41' },
    ], { status: 'pr_opened', actionUrl: 'https://github.com/iotserver24/final-devhost/pull/9' });
    expect(coldSandbox(cold)?.sandboxId).toBe('sb-cold');
    expect(planResume([cold], { number: 41, onPullRequest: false })?.phase).toBe('reply');
    expect(planResume([cold], { number: 9, onPullRequest: true })?.phase).toBe('reply');
    expect(planResume([cold], { number: 8, onPullRequest: true })).toBeNull();
  });

  it('selects only comments that arrived after the pause', () => {
    const comments = [
      { id: 1, body: 'too early', created_at: '2026-11-13T10:04:00.000Z', user: { login: 'iotserver24', type: 'User' } },
      { id: 2, body: 'Use the null check.', created_at: '2026-11-13T10:06:00.000Z', user: { login: 'iotserver24', type: 'User' } },
      { id: 3, body: 'bot note', created_at: '2026-11-13T10:07:00.000Z', user: { login: 'sentinal-ai-bot[bot]', type: 'Bot' } },
    ];
    const fresh = selectFreshComments(comments, '2026-11-13T10:05:00.000Z', (author, userType) => authorMayComment(author, userType, 'iotserver24/final-devhost', []));
    expect(fresh.map(item => item.id)).toEqual([2]);
  });
});
