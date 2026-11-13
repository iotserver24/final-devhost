/**
 * GitHub PR comment follow-up.
 *
 * A reviewer comments on an AI pull request and the agent continues the work.
 * Everything here treats the comment body as untrusted input: only the mention
 * plus an optional instruction is used, authorization is checked against an
 * explicit allowlist, deliveries are deduplicated, and runs are serialized per
 * pull request.
 */

export interface CommentEvent {
  repository: string;
  pullRequestNumber: number;
  commentId: number;
  author: string;
  body: string;
  installationId?: number;
  deliveryId?: string;
  /** Head branch the comment refers to, when GitHub reports it. */
  headBranch?: string;
}

export interface ParsedCommand {
  triggered: boolean;
  instruction?: string;
  reason?: string;
}

export type UpdateStrategy = 'resume' | 'fresh';

const MAX_INSTRUCTION = 2_000;

/** True when the author is on the explicit allowlist (case-insensitive). */
export function isAuthorizedAuthor(author: string, allowlist: string[]): boolean {
  if (!author) return false;
  const normalized = author.trim().toLowerCase().replace(/\[bot\]$/, '');
  return allowlist.some(entry => entry.trim().toLowerCase().replace(/\[bot\]$/, '') === normalized);
}

/**
 * Extract an instruction from a comment that mentions the bot. A bare mention
 * with no instruction is not a command.
 */
export function parseCommand(body: string, mention = '@sentinel'): ParsedCommand {
  if (typeof body !== 'string' || !body.trim()) return { triggered: false, reason: 'Empty comment.' };
  const pattern = new RegExp(`${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (!pattern.test(body)) return { triggered: false, reason: 'No command mention.' };
  const instruction = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(pattern, ' ')
    .replace(/\r/g, '')
    .trim();
  if (!instruction) return { triggered: false, reason: 'The mention had no instruction.' };
  if (instruction.length > MAX_INSTRUCTION) return { triggered: false, reason: 'The instruction is too long.' };
  return { triggered: true, instruction: instruction.slice(0, MAX_INSTRUCTION) };
}

interface WebhookPayload { action?: unknown; issue?: unknown; comment?: unknown; repository?: unknown; installation?: unknown }

export interface WebhookContext {
  /** Repository the controller is allowed to act on. */
  allowedRepository: string;
  /** Installation ID configured for the app, when one is set. */
  allowedInstallationId?: string;
  /** Users permitted to trigger the agent. */
  allowedAuthors: string[];
  mention?: string;
}

export type WebhookOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'event'; event: CommentEvent; instruction: string };

/**
 * Validate an `issue_comment` webhook. Anything that does not match the
 * configured repository, installation, and author allowlist is ignored rather
 * than rejected loudly, so unrelated repositories in the installation do not
 * generate noise.
 */
export function readCommentWebhook(payload: unknown, context: WebhookContext): WebhookOutcome {
  const body = payload && typeof payload === 'object' ? payload as WebhookPayload : undefined;
  if (!body) return { kind: 'ignored', reason: 'Empty payload.' };
  if (body.action !== 'created') return { kind: 'ignored', reason: `Action "${String(body.action)}" is not a new comment.` };

  const issue = body.issue && typeof body.issue === 'object' ? body.issue as Record<string, unknown> : undefined;
  const comment = body.comment && typeof body.comment === 'object' ? body.comment as Record<string, unknown> : undefined;
  const repository = body.repository && typeof body.repository === 'object' ? body.repository as Record<string, unknown> : undefined;
  if (!issue || !comment || !repository) return { kind: 'ignored', reason: 'Payload is missing issue, comment, or repository.' };
  if (!('pull_request' in issue)) return { kind: 'ignored', reason: 'Comment is on an issue, not a pull request.' };

  const fullName = typeof repository.full_name === 'string' ? repository.full_name : '';
  if (fullName.toLowerCase() !== context.allowedRepository.toLowerCase()) {
    return { kind: 'ignored', reason: `Repository "${fullName}" is not the configured remediation repository.` };
  }

  const installation = body.installation && typeof body.installation === 'object' ? body.installation as Record<string, unknown> : undefined;
  const installationId = typeof installation?.id === 'number' ? installation.id : undefined;
  if (context.allowedInstallationId && String(installationId ?? '') !== context.allowedInstallationId) {
    return { kind: 'ignored', reason: 'Installation does not match the configured installation.' };
  }

  const author = typeof comment.user === 'object' && comment.user && 'login' in comment.user
    ? String((comment.user as { login?: unknown }).login ?? '')
    : '';
  if (!isAuthorizedAuthor(author, context.allowedAuthors)) {
    return { kind: 'ignored', reason: `Author "${author}" is not on the command allowlist.` };
  }

  const commentBody = typeof comment.body === 'string' ? comment.body : '';
  const command = parseCommand(commentBody, context.mention ?? '@sentinel');
  if (!command.triggered) return { kind: 'ignored', reason: command.reason ?? 'Not a command.' };

  const number = typeof issue.number === 'number' ? issue.number : undefined;
  const commentId = typeof comment.id === 'number' ? comment.id : undefined;
  if (!number || !commentId) return { kind: 'ignored', reason: 'Payload is missing the PR number or comment id.' };

  const head = issue.pull_request && typeof issue.pull_request === 'object' ? issue.pull_request as Record<string, unknown> : undefined;
  const headBranch = typeof head?.head === 'string' ? head.head : undefined;

  return {
    kind: 'event',
    instruction: command.instruction!,
    event: {
      repository: fullName,
      pullRequestNumber: number,
      commentId,
      author,
      body: commentBody,
      ...(installationId !== undefined ? { installationId } : {}),
      ...(headBranch ? { headBranch } : {}),
    },
  };
}

/** Duplicate webhook deliveries must never start duplicate runs. */
export class DeliveryLedger {
  private readonly seenIds = new Set<string>();
  constructor(private readonly capacity = 1_000) {}

  /** Returns true when this delivery is new and should be processed. */
  claim(deliveryId: string): boolean {
    if (!deliveryId) return false;
    if (this.seenIds.has(deliveryId)) return false;
    this.seenIds.add(deliveryId);
    if (this.seenIds.size > this.capacity) this.seenIds.delete(this.seenIds.values().next().value!);
    return true;
  }

  has(deliveryId: string): boolean {
    return this.seenIds.has(deliveryId);
  }
}

/** One run at a time per pull request. */
export class RunLock {
  private readonly active = new Map<string, number>();
  constructor(private readonly ttlMs = 30 * 60_000, private readonly now: () => number = Date.now) {}

  tryAcquire(key: string): boolean {
    const current = this.active.get(key);
    if (current !== undefined && current > this.now()) return false;
    this.active.set(key, this.now() + this.ttlMs);
    return true;
  }

  release(key: string): void {
    this.active.delete(key);
  }

  isLocked(key: string): boolean {
    const current = this.active.get(key);
    return current !== undefined && current > this.now();
  }
}

/**
 * Decide how to continue the investigation. E2B sandboxes are not guaranteed to
 * be resumable indefinitely, so an expired or unsupported sandbox falls back to
 * a fresh one rebuilt from the PR branch, the incident record, and the review
 * comments.
 */
export function chooseStrategy(options: {
  sandboxResumeSupported: boolean;
  previousSandboxId?: string;
  previousExpiresAt?: string;
  now?: Date;
}): { strategy: UpdateStrategy; reason: string } {
  const now = options.now ?? new Date();
  if (!options.sandboxResumeSupported) {
    return { strategy: 'fresh', reason: 'The sandbox provider does not support resuming; a new sandbox is created from the PR branch and incident context.' };
  }
  if (!options.previousSandboxId) {
    return { strategy: 'fresh', reason: 'No previous sandbox is recorded for this incident; creating a new one.' };
  }
  if (!options.previousExpiresAt) {
    return { strategy: 'fresh', reason: 'The previous sandbox has no recorded expiry; assuming it is unavailable.' };
  }
  const expires = Date.parse(options.previousExpiresAt);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { strategy: 'fresh', reason: 'The previous sandbox has expired; creating a new one from the PR branch and incident context.' };
  }
  return { strategy: 'resume', reason: 'The previous sandbox is still available; continuing in place.' };
}

/** Context reconstructed for a fresh sandbox after the old one is gone. */
export interface FollowupContext {
  repository: string;
  pullRequestNumber: number;
  headBranch: string;
  instruction: string;
  incidentId?: string;
  previousComments: string[];
}

export function buildFollowupContext(event: CommentEvent, instruction: string, options: {
  incidentId?: string;
  previousComments?: string[];
} = {}): FollowupContext {
  return {
    repository: event.repository,
    pullRequestNumber: event.pullRequestNumber,
    headBranch: event.headBranch ?? `agent/incident-${options.incidentId?.toLowerCase() ?? 'followup'}`,
    instruction,
    ...(options.incidentId ? { incidentId: options.incidentId } : {}),
    previousComments: (options.previousComments ?? []).slice(-10).map(comment => comment.slice(0, 500)),
  };
}