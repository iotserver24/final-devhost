/**
 * Optional PostHog error-tracking evidence.
 *
 * Advisory only: issues are attached as context and never trigger an action
 * by themselves. Missing configuration, downtime, and rate limits become
 * "no evidence".
 */

export interface PostHogIssue {
  id: string;
  title: string;
  status: string;
  count: number;
}

export interface PostHogEvidence {
  configured: boolean;
  ok: boolean;
  issues: PostHogIssue[];
  detail: string;
}

export interface PostHogClientOptions {
  projectId?: string;
  token?: string;
  host?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
}

const TITLE_LIMIT = 120;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

export class PostHogClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly host: string;

  constructor(private readonly options: PostHogClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 6_000, 20_000));
    this.host = (options.host ?? 'https://us.posthog.com').replace(/\/$/, '');
  }

  configured(): boolean {
    return Boolean(this.options.projectId && this.options.token);
  }

  async recentIssues(): Promise<PostHogEvidence> {
    if (!this.configured()) {
      return { configured: false, ok: false, issues: [], detail: 'PostHog is not configured.' };
    }
    const limit = Math.max(1, Math.min(this.options.limit ?? 5, 25));
    const url = `${this.host}/api/projects/${encodeURIComponent(this.options.projectId!)}/error_tracking/issues/?status=active&limit=${limit}`;
    try {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 429) return { configured: true, ok: false, issues: [], detail: 'PostHog rate limit reached; no evidence attached.' };
      if (!response.ok) return { configured: true, ok: false, issues: [], detail: `PostHog returned HTTP ${response.status}; no evidence attached.` };
      const body = await response.json() as unknown;
      const rows = Array.isArray(body) ? body : record(body)?.results;
      if (!Array.isArray(rows)) return { configured: true, ok: false, issues: [], detail: 'PostHog returned an unexpected payload.' };
      const issues = rows.flatMap(entry => this.mapIssue(entry)).slice(0, limit);
      return {
        configured: true,
        ok: true,
        issues,
        detail: issues.length ? `${issues.length} active PostHog error issue(s).` : 'No active PostHog error issues.',
      };
    } catch {
      return { configured: true, ok: false, issues: [], detail: 'PostHog was unreachable; no evidence attached.' };
    }
  }

  private mapIssue(entry: unknown): PostHogIssue[] {
    const item = record(entry);
    if (!item) return [];
    const id = typeof item.id === 'string' ? item.id : typeof item.id === 'number' ? String(item.id) : undefined;
    if (!id) return [];
    const rawTitle = typeof item.name === 'string' ? item.name : typeof item.description === 'string' ? item.description : 'Untitled PostHog issue';
    const aggregations = record(item.aggregations);
    const count = countOf(item.occurrences ?? aggregations?.occurrences);
    const status = typeof item.status === 'string' ? item.status : 'active';
    return [{ id, title: rawTitle.replace(/\s+/g, ' ').slice(0, TITLE_LIMIT), status, count }];
  }

  async evidenceLines(projectId?: string): Promise<string[]> {
    const client = projectId && projectId !== this.options.projectId ? new PostHogClient({ ...this.options, projectId }) : this;
    const evidence = await client.recentIssues();
    if (!evidence.ok) return [];
    return evidence.issues.map(issue => `PostHog ${issue.id}: ${issue.title} (${issue.status}, ${issue.count} event${issue.count === 1 ? '' : 's'})`);
  }
}

export function posthogFromEnvironment(env: Record<string, string | undefined> = process.env): PostHogClient {
  return new PostHogClient({
    projectId: env.POSTHOG_PROJECT_ID?.trim() || undefined,
    token: env.POSTHOG_PERSONAL_API_KEY?.trim() || undefined,
    ...(env.POSTHOG_HOST?.trim() ? { host: env.POSTHOG_HOST.trim() } : {}),
  });
}
