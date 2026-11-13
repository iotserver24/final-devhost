/**
 * Optional Sentry evidence source.
 *
 * Sentry is advisory: its issues are attached to an incident as extra evidence
 * and are never, on their own, sufficient to trigger an automated action.
 * Missing configuration, downtime, and rate limits degrade to "no evidence".
 */

export interface SentryIssue {
  id: string;
  title: string;
  level: string;
  count: number;
  lastSeen?: string;
  shortId?: string;
}

export interface SentryEvidence {
  configured: boolean;
  ok: boolean;
  issues: SentryIssue[];
  detail: string;
}

export interface SentryClientOptions {
  org?: string;
  project?: string;
  token?: string;
  baseUrl?: string;
  /** When set, only issues from this Sentry environment are requested. */
  environment?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  lookbackMinutes?: number;
  limit?: number;
}

const ISSUE_TITLES = 120;

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function compare(value: unknown): simplyIssue | undefined {
  return value && typeof value === 'object' ? value as simplyIssue : undefined;
}
type simplyIssue = Record<string, unknown>;

export class SentryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(private readonly options: SentryClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 6_000, 20_000));
    this.baseUrl = (options.baseUrl ?? 'https://sentry.io').replace(/\/$/, '');
  }

  configured(): boolean {
    return Boolean(this.options.org && this.options.project && this.options.token);
  }

  /**
   * Recent unresolved issues. Never throws: a failure is reported as
   * `ok: false` so callers can continue without evidence.
   */
  async recentIssues(): Promise<SentryEvidence> {
    if (!this.configured()) {
      return { configured: false, ok: false, issues: [], detail: 'Sentry is not configured.' };
    }
    const limit = Math.max(1, Math.min(this.options.limit ?? 5, 25));
    const period = Math.max(5, Math.min(this.options.lookbackMinutes ?? 60, 1_440));
    const query = this.options.environment ? `is:unresolved environment:${this.options.environment}` : 'is:unresolved';
    const url = `${this.baseUrl}/api/0/projects/${encodeURIComponent(this.options.org!)}/${encodeURIComponent(this.options.project!)}/issues/?query=${encodeURIComponent(query)}&statsPeriod=${period}m&limit=${limit}`;
    try {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 429) return { configured: true, ok: false, issues: [], detail: 'Sentry rate limit reached; no evidence attached.' };
      if (!response.ok) return { configured: true, ok: false, issues: [], detail: `Sentry returned HTTP ${response.status}; no evidence attached.` };
      const body = await response.json() as unknown;
      if (!Array.isArray(body)) return { configured: true, ok: false, issues: [], detail: 'Sentry returned an unexpected payload.' };
      const issues = body.flatMap(entry => this.mapIssue(entry)).slice(0, limit);
      return { configured: true, ok: true, issues, detail: issues.length ? `${issues.length} unresolved Sentry issue(s).` : 'No unresolved Sentry issues in the lookback window.' };
    } catch {
      return { configured: true, ok: false, issues: [], detail: 'Sentry was unreachable; no evidence attached.' };
    }
  }

  private mapIssue(entry: unknown): SentryIssue[] {
    const item = compare(entry);
    if (!item) return [];
    const id = typeof item.id === 'string' ? item.id : typeof item.id === 'number' ? String(item.id) : undefined;
    if (!id) return [];
    const title = typeof item.title === 'string' ? item.title.slice(0, ISSUE_TITLES) : 'Untitled Sentry issue';
    const level = typeof item.level === 'string' ? item.level : 'error';
    const count = countOf(item.count);
    const lastSeen = typeof item.lastSeen === 'string' ? item.lastSeen : undefined;
    const shortId = typeof item.shortId === 'string' ? item.shortId : undefined;
    return [{ id, title, level, count, ...(lastSeen ? { lastSeen } : {}), ...(shortId ? { shortId } : {}) }];
  }

  /** Evidence lines suitable for an incident, bounded and redaction-safe. */
  async evidenceLines(project?: string): Promise<string[]> {
    const client = project && project !== this.options.project ? new SentryClient({ ...this.options, project }) : this;
    const evidence = await client.recentIssues();
    if (!evidence.ok) return [];
    return evidence.issues.map(issue => `Sentry${issue.shortId ? ` ${issue.shortId}` : ''}: ${issue.title} (${issue.level}, ${issue.count} event${issue.count === 1 ? '' : 's'})`);
  }
}

export function sentryFromEnvironment(env: Record<string, string | undefined> = process.env): SentryClient {
  return new SentryClient({
    org: env.SENTRY_ORG?.trim() || undefined,
    project: env.SENTRY_PROJECT?.trim() || undefined,
    token: env.SENTRY_AUTH_TOKEN?.trim() || undefined,
    ...(env.SENTRY_BASE_URL?.trim() ? { baseUrl: env.SENTRY_BASE_URL.trim() } : {}),
    ...(env.SENTRY_ENVIRONMENT?.trim() ? { environment: env.SENTRY_ENVIRONMENT.trim() } : {}),
  });
}