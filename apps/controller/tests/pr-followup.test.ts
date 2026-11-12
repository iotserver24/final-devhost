import { describe, expect, test } from 'bun:test';
import {
  DeliveryLedger,
  RunLock,
  buildFollowupContext,
  chooseStrategy,
  isAuthorizedAuthor,
  parseCommand,
  readCommentWebhook,
} from '../src/pr-followup';

const context = {
  allowedRepository: 'acme/testsite',
  allowedInstallationId: '4242',
  allowedAuthors: ['alice', 'bob'],
  mention: '@sentinel',
};

function payload(overrides: {
  action?: string;
  repo?: string;
  author?: string;
  body?: string;
  number?: number;
  commentId?: number;
  installationId?: number;
  isPullRequest?: boolean;
} = {}) {
  return {
    action: overrides.action ?? 'created',
    installation: { id: overrides.installationId ?? 4242 },
    repository: { full_name: overrides.repo ?? 'acme/testsite' },
    issue: {
      number: overrides.number ?? 17,
      ...(overrides.isPullRequest === false ? {} : { pull_request: { url: 'https://api.github.com/pulls/17' } }),
    },
    comment: { id: overrides.commentId ?? 9001, user: { login: overrides.author ?? 'alice' }, body: overrides.body ?? '@sentinel also handle an empty config file' },
  };
}

describe('PR comment authorization', () => {
  test('only allowlisted authors can command the agent', () => {
    expect(isAuthorizedAuthor('alice', ['alice', 'bob'])).toBe(true);
    expect(isAuthorizedAuthor('ALICE', ['alice'])).toBe(true);
    expect(isAuthorizedAuthor('alice[bot]', ['alice'])).toBe(true);
    expect(isAuthorizedAuthor('mallory', ['alice', 'bob'])).toBe(false);
    expect(isAuthorizedAuthor('', ['alice'])).toBe(false);
  });

  test('an unauthorized author is ignored, not an error', () => {
    const outcome = readCommentWebhook(payload({ author: 'mallory' }), context);
    expect(outcome.kind).toBe('ignored');
    if (outcome.kind === 'ignored') expect(outcome.reason).toContain('allowlist');
  });

  test('a different repository or installation is ignored', () => {
    expect(readCommentWebhook(payload({ repo: 'other/repo' }), context).kind).toBe('ignored');
    expect(readCommentWebhook(payload({ installationId: 999 }), context).kind).toBe('ignored');
  });

  test('issue comments (not on a PR) are ignored', () => {
    expect(readCommentWebhook(payload({ isPullRequest: false }), context).kind).toBe('ignored');
  });

  test('non-created actions are ignored', () => {
    expect(readCommentWebhook(payload({ action: 'edited' }), context).kind).toBe('ignored');
  });
});

describe('PR command parsing', () => {
  test('extracts the instruction after the mention', () => {
    const parsed = parseCommand('@sentinel The fix works, but also handle an empty configuration file.');
    expect(parsed.triggered).toBe(true);
    expect(parsed.instruction).toContain('empty configuration file');
    expect(parsed.instruction).not.toContain('@sentinel');
  });

  test('a body without the mention is not a command', () => {
    expect(parseCommand('looks good to me').triggered).toBe(false);
  });

  test('a bare mention with no instruction is not a command', () => {
    expect(parseCommand('@sentinel').triggered).toBe(false);
  });

  test('HTML comments are stripped and oversized instructions rejected', () => {
    expect(parseCommand('@sentinel <!-- sneaky --> add logging').instruction).toBe('add logging');
    expect(parseCommand(`@sentinel ${'x'.repeat(5_000)}`).triggered).toBe(false);
  });

  test('a valid event carries repository, PR number, author, and instruction', () => {
    const outcome = readCommentWebhook(payload({ body: '@sentinel add a regression test' }), context);
    expect(outcome.kind).toBe('event');
    if (outcome.kind === 'event') {
      expect(outcome.event).toMatchObject({ repository: 'acme/testsite', pullRequestNumber: 17, commentId: 9001, author: 'alice' });
      expect(outcome.instruction).toBe('add a regression test');
    }
  });
});

describe('webhook idempotency', () => {
  test('the same delivery is processed only once', () => {
    const ledger = new DeliveryLedger();
    expect(ledger.claim('delivery-1')).toBe(true);
    expect(ledger.claim('delivery-1')).toBe(false);
    expect(ledger.claim('delivery-2')).toBe(true);
  });

  test('an empty delivery id is never claimed', () => {
    expect(new DeliveryLedger().claim('')).toBe(false);
  });

  test('the ledger is bounded', () => {
    const ledger = new DeliveryLedger(2);
    ledger.claim('a');
    ledger.claim('b');
    ledger.claim('c');
    expect(ledger.has('a')).toBe(false);
  });
});

describe('overlapping runs', () => {
  test('one run at a time per pull request', () => {
    let now = 0;
    const lock = new RunLock(1_000, () => now);
    const key = 'acme/testsite#17';
    expect(lock.tryAcquire(key)).toBe(true);
    expect(lock.tryAcquire(key)).toBe(false);
    expect(lock.isLocked(key)).toBe(true);
    lock.release(key);
    expect(lock.tryAcquire(key)).toBe(true);
  });

  test('leases expire so a crashed run cannot block forever', () => {
    let now = 0;
    const lock = new RunLock(1_000, () => now);
    expect(lock.tryAcquire('pr')).toBe(true);
    now = 1_001;
    expect(lock.tryAcquire('pr')).toBe(true);
  });
});

describe('sandbox resume and fallback', () => {
  const now = new Date('2026-03-01T12:00:00Z');

  test('resumes a sandbox that is still alive', () => {
    const decision = chooseStrategy({ sandboxResumeSupported: true, previousSandboxId: 'sbx-1', previousExpiresAt: '2026-03-01T13:00:00Z', now });
    expect(decision.strategy).toBe('resume');
  });

  test('falls back to a fresh sandbox when the old one expired', () => {
    const decision = chooseStrategy({ sandboxResumeSupported: true, previousSandboxId: 'sbx-1', previousExpiresAt: '2026-03-01T11:00:00Z', now });
    expect(decision.strategy).toBe('fresh');
    expect(decision.reason).toContain('expired');
  });

  test('falls back when resume is unsupported or no sandbox is recorded', () => {
    expect(chooseStrategy({ sandboxResumeSupported: false, previousSandboxId: 'sbx-1', previousExpiresAt: '2026-03-01T13:00:00Z', now }).strategy).toBe('fresh');
    expect(chooseStrategy({ sandboxResumeSupported: true, now }).strategy).toBe('fresh');
    expect(chooseStrategy({ sandboxResumeSupported: true, previousSandboxId: 'sbx-1', now }).strategy).toBe('fresh');
  });

  test('fresh-sandbox context includes bounded review history', () => {
    const followup = buildFollowupContext(
      { repository: 'acme/testsite', pullRequestNumber: 17, commentId: 1, author: 'alice', body: '', headBranch: 'agent/incident-42' },
      'handle empty config',
      { incidentId: 'inc-42', previousComments: ['first', 'second'] },
    );
    expect(followup.headBranch).toBe('agent/incident-42');
    expect(followup.instruction).toBe('handle empty config');
    expect(followup.previousComments).toEqual(['first', 'second']);
    expect(followup.incidentId).toBe('inc-42');
  });
});