import type { Deployment, DeploymentProvider, DeploymentState, DeploymentStatus, DeploymentSummary, ProbeResponse, RateLimitInfo, RuntimeLog } from './monitor';
import { redact, redactFull } from '@nexathon/notifier/format';

const apiBase = 'https://api.vercel.com';

type JsonObject = Record<string, unknown>;

export interface VercelProviderOptions {
  accessToken: string;
  projectId: string;
  productionDomain: string;
  teamId?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Recent history to fetch; defaults to one minute. */
  runtimeLogWindowMs?: number;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function deploymentUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw.startsWith('https://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app')
      || url.username || url.password || url.port || url.search || url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' || /^\d+$/.test(value)
    ? new Date(Number(value))
    : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function mapDeployment(value: unknown, projectId: string): Deployment | undefined {
  const item = object(value);
  if (!item || item.projectId !== projectId || item.readyState !== 'READY' || item.target !== 'production') return undefined;
  const id = text(item.uid) ?? text(item.id);
  const immutableUrl = deploymentUrl(item.url);
  const createdAt = isoDate(item.createdAt) ?? isoDate(item.created);
  if (!id || !immutableUrl || !createdAt) return undefined;

  const metadata = object(item.meta);
  const commitSha = metadata
    ? text(metadata.githubCommitSha) ?? text(metadata.gitlabCommitSha) ?? text(metadata.gitCommitSha)
    : undefined;
  return { id, immutableUrl, createdAt, ...(commitSha ? { commitSha } : {}) };
}

function mapDeploymentStatus(value: unknown, projectId: string): DeploymentStatus | undefined {
  const item = object(value);
  if (!item || item.projectId !== projectId || item.target !== 'production') return undefined;
  const id = text(item.uid) ?? text(item.id);
  const createdAt = isoDate(item.createdAt) ?? isoDate(item.created);
  const state = text(item.readyState) ?? text(item.state);
  if (!id || !createdAt || !state) return undefined;
  const metadata = object(item.meta);
  const commitSha = metadata
    ? text(metadata.githubCommitSha) ?? text(metadata.gitlabCommitSha) ?? text(metadata.gitCommitSha)
    : undefined;
  const knownState: DeploymentState = ['QUEUED', 'BUILDING', 'READY', 'ERROR', 'CANCELED'].includes(state)
    ? state as DeploymentState
    : 'UNKNOWN';
  const immutableUrl = deploymentUrl(item.url);
  return { id, state: knownState, createdAt, ...(immutableUrl ? { immutableUrl } : {}), ...(commitSha ? { commitSha } : {}) };
}

function rateLimitResetMs(value: number): number {
  // Vercel reports x-ratelimit-reset in milliseconds, but guard against
  // second-precision timestamps so the backoff window is never wrong by 1000x.
  return value > 1e11 ? value : value * 1000;
}

export class VercelProvider implements DeploymentProvider {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly productionDomain: string;
  private rateLimit: RateLimitInfo | null = null;
  private logOwnerId?: string;

  constructor(private readonly options: VercelProviderOptions) {
    if (!options.accessToken.trim()) throw new Error('Vercel access token is required.');
    if (!options.projectId.trim()) throw new Error('Vercel project ID is required.');
    const domain = options.productionDomain.trim().toLowerCase();
    if (!domain || domain.includes('/') || domain.includes('@') || domain.includes(':')) {
      throw new Error('A hostname-only production domain is required.');
    }
    this.productionDomain = domain;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 8_000, 20_000));
  }

  private assertProject(projectId: string): void {
    if (projectId !== this.options.projectId) throw new Error('Vercel provider is scoped to a different project.');
  }

  private apiUrl(path: string, query: Record<string, string | undefined> = {}): URL {
    const url = new URL(path, apiBase);
    if (this.options.teamId) query.teamId = this.options.teamId;
    for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
    return url;
  }

  private async request(url: URL, init: RequestInit = {}, attempt = 0): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, 12_000)),
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          Accept: 'application/json',
          ...init.headers,
        },
      });
      this.trackRateLimit(response);
      if (!response.ok) {
        // Preserve validation/permission diagnostics, but never echo credentials.
        let detail = '';
        try {
          const body = object(await response.json());
          const error = object(body?.error);
          detail = [text(error?.code), text(error?.message) ?? text(body?.message)].filter(Boolean).join(': ');
        } catch { /* non-JSON error bodies are not useful diagnostics */ }
        detail = redact(detail.replaceAll(this.options.accessToken, '[REDACTED]'), 350);
        throw new Error(`Vercel API request failed with HTTP ${response.status} (${url.hostname}${url.pathname})${detail ? `: ${detail}` : '.'}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Vercel API request failed')) throw error;
      if (attempt < 1) return this.request(url, init, attempt + 1);
      throw new Error('Vercel API request failed or timed out.');
    }
  }

  private trackRateLimit(response: Response): void {
    const numberHeader = (name: string): number | null => {
      const raw = response.headers.get(name);
      const parsed = raw === null ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const info: RateLimitInfo = {
      limit: numberHeader('x-ratelimit-limit'),
      remaining: numberHeader('x-ratelimit-remaining'),
      reset: numberHeader('x-ratelimit-reset'),
    };
    if (info.limit !== null || info.remaining !== null || info.reset !== null) {
      this.rateLimit = { ...info, ...(info.reset !== null ? { reset: rateLimitResetMs(info.reset) } : {}) };
    }
  }

  getRateLimit(): RateLimitInfo | null {
    return this.rateLimit;
  }

  private async getDeployment(id: string): Promise<Deployment | null> {
    const url = this.apiUrl(`/v13/deployments/${encodeURIComponent(id)}`);
    const response = await this.request(url);
    const deployment = mapDeployment(await response.json(), this.options.projectId);
    return deployment ?? null;
  }

  async getProductionDeployment(projectId: string): Promise<Deployment | null> {
    this.assertProject(projectId);
    const aliasesUrl = this.apiUrl('/v4/aliases', {
      projectId: this.options.projectId,
      limit: '100',
    });
    const aliasesResponse = await this.request(aliasesUrl);
    const body = object(await aliasesResponse.json());
    const aliases = Array.isArray(body?.aliases) ? body.aliases : [];
    const alias = aliases
      .map(object)
      .find(item => item && item.alias === this.productionDomain
        && item.projectId === this.options.projectId && !item.deletedAt);
    const deployment = object(alias?.deployment);
    const deploymentId = text(alias?.deploymentId) ?? text(deployment?.id);
    if (deploymentId) return this.getDeployment(deploymentId);
    const latest = await this.getLatestDeploymentStatus(projectId);
    if (!latest || latest.state === 'ERROR') return null;
    return this.getDeployment(latest.id);
  }

  async getLatestDeploymentStatus(projectId: string): Promise<DeploymentStatus | null> {
    this.assertProject(projectId);
    const response = await this.request(this.apiUrl('/v6/deployments', {
      projectId: this.options.projectId,
      target: 'production',
      limit: '20',
    }));
    const body = object(await response.json());
    const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
    return deployments
      .map(item => mapDeploymentStatus(item, this.options.projectId))
      .filter((item): item is DeploymentStatus => Boolean(item))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  }

  async listDeploymentsSince(projectId: string, sinceMs: number): Promise<DeploymentSummary[]> {
    this.assertProject(projectId);
    if (!Number.isFinite(sinceMs)) throw new Error('A valid since timestamp is required.');
    const response = await this.request(this.apiUrl('/v7/deployments', {
      projectId: this.options.projectId,
      target: 'production',
      since: String(Math.trunc(sinceMs)),
      limit: '20',
    }));
    const body = object(await response.json());
    const deployments = Array.isArray(body?.deployments) ? body.deployments : [];
    return deployments
      .map(item => mapDeploymentStatus(item, this.options.projectId))
      .filter((item): item is DeploymentStatus => Boolean(item))
      .filter(item => Date.parse(item.createdAt) >= sinceMs)
      .map(item => ({ id: item.id, state: item.state, createdAt: item.createdAt }));
  }

  async getDeploymentEvents(projectId: string, deploymentId: string): Promise<RuntimeLog[]> {
    this.assertProject(projectId);
    if (!deploymentId.trim()) throw new Error('Vercel deployment ID is required.');
    const url = this.apiUrl(`/v3/deployments/${encodeURIComponent(deploymentId)}/events`, { limit: '150' });
    const response = await this.request(url);
    const values = parseLogStream(await response.text());
    return values.flatMap((value, index) => {
      const item = object(value);
      const message = text(item?.text);
      if (!message) return [];
      const type = text(item?.type) ?? 'stdout';
      const level = type === 'error' || type === 'fatal' ? 'error' : type === 'stderr' ? 'warn' : 'info';
      const timestamp = typeof item?.created === 'number' ? item.created
        : typeof item?.date === 'number' ? item.date
        : Date.now();
      return [{
        id: text(item?.id) ?? text(item?.serial) ?? `${deploymentId}-event-${index}`,
        level,
        message: redact(message, 600),
        timestamp,
        isError: level === 'error',
      }];
    }).slice(-50);
  }

  async getRuntimeLogs(projectId: string, deploymentId: string): Promise<RuntimeLog[]> {
    this.assertProject(projectId);
    if (!deploymentId.trim()) throw new Error('Vercel deployment ID is required.');
    const now = Date.now();
    if (!this.logOwnerId) {
      // The CLI uses the project's accountId, including for Hobby workspaces.
      const response = await this.request(this.apiUrl(`/v9/projects/${encodeURIComponent(projectId)}`));
      const project = object(await response.json());
      this.logOwnerId = text(project?.accountId);
      if (!this.logOwnerId) throw new Error('Vercel project metadata did not include an accountId for runtime logs.');
    }
    const windowMs = this.options.runtimeLogWindowMs ?? 60_000;
    if (!Number.isFinite(windowMs) || windowMs < 1 || windowMs > 30 * 60_000) {
      throw new Error('Vercel runtime log window must be between 1 ms and 30 minutes.');
    }
    // Match Vercel CLI's logs-v2 transport. This is an internal dashboard API,
    // not the documented live deployment runtime-logs stream.
    // https://github.com/vercel/vercel/blob/main/packages/cli/src/util/logs-v2.ts
    const rows: unknown[] = [];
    for (let page = 0; page < 10; page++) {
      const url = new URL('/api/logs/request-logs', 'https://vercel.com');
      const query = {
        projectId, ownerId: this.logOwnerId, deploymentId, environment: 'production',
        startDate: String(now - windowMs), endDate: String(now), page: String(page),
        ...(this.options.teamId ? { teamId: this.options.teamId } : {}),
      };
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await this.request(url);
      const body = object(await response.json());
      if (!Array.isArray(body?.rows)) throw new Error('Vercel runtime logs returned an unexpected response (missing rows).');
      rows.push(...body.rows);
      if (body.hasMoreRows !== true) break;
      if (page === 9 || body.rows.length === 0) {
        throw new Error('Vercel runtime logs exceeded the pagination limit; shorten the log window.');
      }
    }
    const logs: RuntimeLog[] = [];
    for (const row of rows) {
      const item = object(row);
      if (!item) continue;
      const requestId = text(item.requestId) ?? text(item.id) ?? `${deploymentId}-${logs.length}`;
      const statusCode = typeof item.statusCode === 'number' ? item.statusCode
        : typeof item.responseStatusCode === 'number' ? item.responseStatusCode
        : undefined;
      const path = text(item.requestPath);
      const method = text(item.requestMethod);
      const timestamp = typeof item.timestampInMs === 'number' ? item.timestampInMs
        : typeof item.timestamp === 'number' ? item.timestamp
        : typeof item.timestamp === 'string' ? Date.parse(item.timestamp)
        : now;
      const nested = Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [item];
      nested.forEach((entry, index) => {
        const line = object(entry);
        const message = text(line?.message) ?? text(line?.text);
        if (!message) return;
        const rawLevel = text(line?.level) ?? (statusCode !== undefined && statusCode >= 500 ? 'error' : 'info');
        const level = rawLevel === 'error' || rawLevel === 'fatal' ? 'error' : rawLevel === 'warning' || rawLevel === 'warn' ? 'warn' : 'info';
        const where = [method, path].filter(Boolean).join(' ');
        logs.push({
          id: `${requestId}:${index}`,
          level,
          message: redactFull(where ? `${where} — ${message}` : message),
          ...(statusCode !== undefined ? { statusCode } : {}),
          timestamp: Number.isFinite(timestamp) ? timestamp : now,
          isError: level === 'error' || (statusCode !== undefined && statusCode >= 500),
        });
      });
    }
    return logs.sort((a, b) => a.timestamp - b.timestamp);
  }

  async getDeploymentLogs(projectId: string, deploymentId: string): Promise<string[]> {
    this.assertProject(projectId);
    if (!deploymentId.trim()) throw new Error('Vercel deployment ID is required.');
    const logs = await this.getDeploymentEvents(projectId, deploymentId);
    return logs.slice(-8).map(log => `${log.level}: ${log.message}`);
  }

  async getPreviousDeployment(projectId: string, deploymentId: string): Promise<Deployment | null> {
    this.assertProject(projectId);
    const current = await this.getDeployment(deploymentId);
    if (!current) return null;

    const deploymentsUrl = this.apiUrl('/v7/deployments', {
      projectId: this.options.projectId,
      target: 'production',
      state: 'READY',
      rollbackCandidate: 'true',
      limit: '20',
    });
    const response = await this.request(deploymentsUrl);
    const body = object(await response.json());
    const items = Array.isArray(body?.deployments) ? body.deployments : [];
    const currentCreatedAt = Date.parse(current.createdAt);
    const candidates = items
      .map(item => mapDeployment(item, this.options.projectId))
      .filter((item): item is Deployment => Boolean(item)
        && item!.id !== current.id
        && Date.parse(item!.createdAt) < currentCreatedAt)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return candidates[0] ?? null;
  }

  async probeImmutableDeployment(deployment: string, probePath: string): Promise<ProbeResponse> {
    const url = deploymentUrl(deployment);
    if (!url || !safeProbePath(probePath)) throw new Error('Invalid immutable deployment probe target.');
    return this.probe(new URL(probePath, url));
  }

  async rollbackProductionTo(projectId: string, deploymentId: string): Promise<{ actionUrl?: string }> {
    this.assertProject(projectId);
    if (!deploymentId.trim()) throw new Error('Rollback target deployment ID is required.');
    const current = await this.getProductionDeployment(projectId);
    if (!current) throw new Error('Current production deployment could not be confirmed.');
    const previous = await this.getPreviousDeployment(projectId, current.id);
    if (previous?.id !== deploymentId) throw new Error('Rollback target is not the confirmed immediate predecessor.');
    const target = await this.getDeployment(deploymentId);
    if (!target) throw new Error('Rollback target is not a ready production deployment in the configured project.');
    const url = this.apiUrl(
      `/v1/projects/${encodeURIComponent(this.options.projectId)}/rollback/${encodeURIComponent(deploymentId)}`,
      { description: 'Autonomous incident remediation: verified current/predecessor probe regression' },
    );
    await this.request(url, { method: 'POST' });
    return { actionUrl: target.immutableUrl };
  }

  async probeProduction(projectId: string, probePath: string): Promise<ProbeResponse> {
    this.assertProject(projectId);
    if (!safeProbePath(probePath)) throw new Error('Invalid production probe path.');
    return this.probe(new URL(probePath, `https://${this.productionDomain}`));
  }

  private async probe(url: URL): Promise<ProbeResponse> {
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'application/json' },
      });
      const status = response.status;
      // Deployment Protection answers 401/403 on private immutable URLs. That is
      // not an application failure and must not open an incident or a fix PR.
      const result = response.ok ? 'pass' : status === 401 || status === 403 ? 'unknown' : 'fail';
      return {
        result,
        evidence: `HTTP ${status} from ${url.hostname}${url.pathname}`,
        statusCode: status,
      };
    } catch {
      throw new Error('Deployment probe failed or timed out.');
    }
  }
}

function parseLogStream(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed.split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line) as unknown]; } catch { return []; }
    });
  }
}

function safeProbePath(path: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path) && !path.includes('..');
}
