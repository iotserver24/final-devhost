import type { Incident } from '@nexathon/contracts';
import { isAuthorizedAuthor } from './pr-followup';

const WAITING = /issue #(\d+)\b[\s\S]*?\bsandbox=([A-Za-z0-9_-]+)/;

/** The diagnosis step is paused until a repository comment. */
export function awaitingComment(incident: Incident): { issueNumber: number; sandboxId: string; at: string } | null {
  const event = [...incident.events].reverse().find(item => item.type === 'awaiting_comment');
  if (!event) return null;
  const resumed = incident.events.some(item => item.type === 'review_resumed' && item.at > event.at);
  if (resumed) return null;
  const match = WAITING.exec(event.message);
  if (!match) return null;
  return { issueNumber: Number(match[1]), sandboxId: match[2], at: event.at };
}

export function awaitingMessage(issueNumber: number, sandboxId: string): string {
  return `Waiting for a comment on issue #${issueNumber} before writing the fix. sandbox=${sandboxId}`;
}

/** Latest cold pause after a pull request. A later comment resumes a reply, not a new diagnosis. */
export function coldSandbox(incident: Incident): { sandboxId: string; issueNumber?: number; at: string } | null {
  const event = [...incident.events].reverse().find(item => item.type === 'cold');
  if (!event) return null;
  const match = /sandbox=([A-Za-z0-9_-]+)(?: issue #(\d+))?/.exec(event.message);
  if (!match) return null;
  const resumed = incident.events.some(item => item.type === 'review_resumed' && item.at > event.at);
  if (resumed) return null;
  return { sandboxId: match[1], at: event.at, ...(match[2] ? { issueNumber: Number(match[2]) } : {}) };
}

export function repositoryOwner(repository: string): string {
  return repository.split('/')[0]?.trim().toLowerCase() ?? '';
}

/** Empty allowlist means the repository owner. A named allowlist is the only other set. Bots never qualify. */
export function authorMayComment(author: string, userType: string | undefined, repository: string, allowedAuthors: string[]): boolean {
  if (!author.trim()) return false;
  if (userType === 'Bot' || /\[bot\]$/i.test(author)) return false;
  if (allowedAuthors.length > 0) return isAuthorizedAuthor(author, allowedAuthors);
  return author.trim().toLowerCase() === repositoryOwner(repository);
}

export interface OwnerComment {
  repository: string;
  number: number;
  commentId: number;
  author: string;
  body: string;
  onPullRequest: boolean;
}

export type OwnerCommentResult = { kind: 'ignored'; reason: string } | { kind: 'comment'; comment: OwnerComment };

interface OwnerCommentContext {
  allowedRepository: string;
  allowedInstallationId?: string;
  allowedAuthors: string[];
}

/** Accept a repository comment without requiring @sentinel. Issue comments and pull request comments both qualify. */
export function readOwnerComment(payload: unknown, context: OwnerCommentContext): OwnerCommentResult {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
  if (!body) return { kind: 'ignored', reason: 'Empty payload.' };
  if (body.action !== 'created') return { kind: 'ignored', reason: 'Not a new comment.' };
  const issue = body.issue && typeof body.issue === 'object' ? body.issue as Record<string, unknown> : undefined;
  const comment = body.comment && typeof body.comment === 'object' ? body.comment as Record<string, unknown> : undefined;
  const repository = body.repository && typeof body.repository === 'object' ? body.repository as Record<string, unknown> : undefined;
  if (!issue || !comment || !repository) return { kind: 'ignored', reason: 'Payload is missing issue, comment, or repository.' };
  const fullName = typeof repository.full_name === 'string' ? repository.full_name : '';
  if (!context.allowedRepository || fullName.toLowerCase() !== context.allowedRepository.toLowerCase()) {
    return { kind: 'ignored', reason: 'Repository is not the configured remediation repository.' };
  }
  const installation = body.installation && typeof body.installation === 'object' ? body.installation as Record<string, unknown> : undefined;
  if (context.allowedInstallationId && String(installation?.id ?? '') !== context.allowedInstallationId) {
    return { kind: 'ignored', reason: 'Installation does not match the configured installation.' };
  }
  const user = comment.user && typeof comment.user === 'object' ? comment.user as Record<string, unknown> : undefined;
  const author = typeof user?.login === 'string' ? user.login : '';
  const userType = typeof user?.type === 'string' ? user.type : undefined;
  if (!authorMayComment(author, userType, fullName, context.allowedAuthors)) {
    return { kind: 'ignored', reason: 'Author cannot resume this incident.' };
  }
  const text = typeof comment.body === 'string' ? comment.body.replace(/<!--[\s\S]*?-->/g, ' ').trim() : '';
  if (!text) return { kind: 'ignored', reason: 'Empty comment.' };
  const number = typeof issue.number === 'number' ? issue.number : undefined;
  const commentId = typeof comment.id === 'number' ? comment.id : undefined;
  if (!number || !commentId) return { kind: 'ignored', reason: 'Payload is missing the issue number or comment id.' };
  return {
    kind: 'comment',
    comment: {
      repository: fullName,
      number,
      commentId,
      author,
      body: text.slice(0, 2_000),
      onPullRequest: 'pull_request' in issue,
    },
  };
}

export interface ResumePlan {
  incident: Incident;
  phase: 'fix' | 'reply';
  sandboxId: string;
  issueNumber?: number;
}

/** Match a comment to the paused diagnosis, or to a cold sandbox after the pull request. */
export function planResume(incidents: Incident[], comment: { number: number; onPullRequest: boolean }): ResumePlan | null {
  if (!comment.onPullRequest) {
    for (const incident of incidents) {
      const waiting = awaitingComment(incident);
      if (waiting && waiting.issueNumber === comment.number) {
        return { incident, phase: 'fix', sandboxId: waiting.sandboxId, issueNumber: waiting.issueNumber };
      }
    }
  }
  for (const incident of incidents) {
    const cold = coldSandbox(incident);
    if (!cold) continue;
    const issueHit = !comment.onPullRequest && cold.issueNumber === comment.number;
    const pullHit = comment.onPullRequest && Boolean(incident.actionUrl?.includes(`/pull/${comment.number}`));
    if (issueHit || pullHit) return { incident, phase: 'reply', sandboxId: cold.sandboxId, issueNumber: cold.issueNumber };
  }
  return null;
}

export interface FreshComment {
  id: number;
  body: string;
  createdAt: string;
  author: string;
}

/** Comments created after the pause, oldest first. The caller decides who is allowed to speak. */
export function selectFreshComments(comments: unknown, since: string, allow: (author: string, userType?: string) => boolean): FreshComment[] {
  if (!Array.isArray(comments)) return [];
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return [];
  const fresh = comments.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'number' ? row.id : undefined;
    const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
    const text = typeof row.body === 'string' ? row.body.replace(/<!--[\s\S]*?-->/g, ' ').trim() : '';
    const user = row.user && typeof row.user === 'object' ? row.user as Record<string, unknown> : undefined;
    const author = typeof user?.login === 'string' ? user.login : '';
    const userType = typeof user?.type === 'string' ? user.type : undefined;
    if (!id || !createdAt || !text || !author) return [];
    if (!(Date.parse(createdAt) > sinceMs)) return [];
    if (!allow(author, userType)) return [];
    return [{ id, body: text.slice(0, 2_000), createdAt, author }];
  });
  return fresh.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}
