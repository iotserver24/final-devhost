import type { Deployment, DeploymentProvider, ProbeResponse } from './monitor';

/**
 * VM deployment provider.
 *
 * The controller never gets SSH or a shell. It talks to a small VM-side agent
 * that exposes a fixed set of operations for one allowlisted application:
 *
 *   GET  /v1/apps/{app}/status   current + previous deployment, health
 *   POST /v1/apps/{app}/rollback { target } — only the recorded previous image
 *   GET  /v1/apps/{app}/logs?lines=N — bounded log tail
 *   GET  /v1/apps/{app}/health   health probe
 *
 * Tradeoff: the agent must be deployed and kept updated on the VM, but it is a
 * far smaller attack surface than remote command execution, and it is the only
 * component that needs Docker access on the host.
 */

export interface VmAgentOptions {
  baseUrl: string;
  application: string;
  /** Bearer token from the controller environment; never embedded in code. */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Log lines requested per pull; bounded. */
  maxLogLines?: number;
}

interface AgentStatusBody {
  current?: { id?: string; image?: string; deployedAt?: string; healthy?: boolean; detail?: string };
  previous?: { id?: string; image?: string; deployedAt?: string };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class VmDeploymentProvider implements DeploymentProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxLogLines: number;
  private readonly baseUrl: string;
  private readonly application: string;

  constructor(private readonly options: VmAgentOptions) {
    if (!SAFE_ID.test(options.application)) throw new Error('VM provider requires a safe application identifier.');
    const url = new URL(options.baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('VM agent URL must not embed credentials.');
    }
    if (url.protocol === 'http:' && !local) throw new Error('VM agent URL must use https outside localhost.');
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.application = options.application;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 6_000, 20_000));
    this.maxLogLines = Math.max(1, Math.min(options.maxLogLines ?? 40, 200));
  }

  /** Provider is scoped to exactly one application; anything else is rejected. */
  private assertProject(projectId: string): void {
    if (projectId !== this.application) throw new Error('VM provider is scoped to a different application.');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers,
    });
  }

  private async status(): Promise<AgentStatusBody> {
    const response = await this.request(`/v1/apps/${encodeURIComponent(this.application)}/status`);
    if (!response.ok) throw new Error(`VM agent status failed with HTTP ${response.status}.`);
    const body = await response.json() as AgentStatusBody;
    if (!body || typeof body !== 'object') throw new Error('VM agent returned an invalid status body.');
    return body;
  }

  private toDeployment(record: AgentStatusBody['current'], fallbackId: string): Deployment | null {
    if (!record) return null;
    const id = typeof record.id === 'string' && SAFE_ID.test(record.id) ? record.id : undefined;
    const image = typeof record.image === 'string' ? record.image : undefined;
    const createdAt = typeof record.deployedAt === 'string' && Number.isFinite(Date.parse(record.deployedAt))
      ? new Date(record.deployedAt).toISOString()
      : undefined;
    if (!id || !createdAt) return null;
    return { id: id || fallbackId, immutableUrl: `vm://${this.application}/${image ?? id}`, createdAt, ...(image ? { commitSha: image } : {}) };
  }

  async getProductionDeployment(projectId: string): Promise<Deployment | null> {
    this.assertProject(projectId);
    const body = await this.status();
    return this.toDeployment(body.current, 'current');
  }

  async getPreviousDeployment(projectId: string, deploymentId: string): Promise<Deployment | null> {
    this.assertProject(projectId);
    const body = await this.status();
    const previous = this.toDeployment(body.previous, 'previous');
    if (!previous) return null;
    // Only the immediate predecessor of the *current* deployment is a valid target.
    const current = this.toDeployment(body.current, 'current');
    return current && current.id === deploymentId ? previous : null;
  }

  async probeProduction(projectId: string): Promise<ProbeResponse> {
    this.assertProject(projectId);
    try {
      const response = await this.request(`/v1/apps/${encodeURIComponent(this.application)}/health`);
      return {
        result: response.ok ? 'pass' : 'fail',
        statusCode: response.status,
        evidence: `VM agent health for ${this.application}: HTTP ${response.status}`,
      };
    } catch {
      throw new Error('VM health probe failed or timed out.');
    }
  }

  async probeImmutableDeployment(): Promise<ProbeResponse> {
    // A stopped previous image cannot be probed without starting it. Report
    // unknown so policy requires the recorded good state instead of guessing.
    return { result: 'unknown', evidence: 'A previous VM image is not running and cannot be probed safely.' };
  }

  async rollbackProductionTo(projectId: string, deploymentId: string): Promise<{ actionUrl?: string }> {
    this.assertProject(projectId);
    const body = await this.status();
    const current = this.toDeployment(body.current, 'current');
    const previous = this.toDeployment(body.previous, 'previous');
    if (!current || !previous || previous.id !== deploymentId) {
      throw new Error('Rollback target is not the confirmed previous VM deployment.');
    }
    const response = await this.request(`/v1/apps/${encodeURIComponent(this.application)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: deploymentId }),
    });
    if (!response.ok) throw new Error(`VM rollback failed with HTTP ${response.status}.`);
    return { actionUrl: `vm://${this.application}/${deploymentId}` };
  }

  /** Show what a rollback would do without touching the VM. */
  async planRollback(projectId: string): Promise<{ current?: string; previous?: string; allowed: boolean; reason: string }> {
    this.assertProject(projectId);
    const body = await this.status();
    const current = this.toDeployment(body.current, 'current');
    const previous = this.toDeployment(body.previous, 'previous');
    if (!current) return { allowed: false, reason: 'The VM agent reports no current deployment.' };
    if (!previous) return { allowed: false, reason: 'No previous known-good deployment is recorded; escalation required.' };
    return { current: current.id, previous: previous.id, allowed: true, reason: 'A previous known-good deployment is recorded and can be restored once.' };
  }

  async getDeploymentLogs(projectId: string): Promise<string[]> {
    this.assertProject(projectId);
    try {
      const response = await this.request(`/v1/apps/${encodeURIComponent(this.application)}/logs?lines=${this.maxLogLines}`);
      if (!response.ok) return [];
      const body = await response.json() as { lines?: unknown };
      return Array.isArray(body.lines)
        ? body.lines.filter((line): line is string => typeof line === 'string').slice(-this.maxLogLines)
        : [];
    } catch {
      return [];
    }
  }
}