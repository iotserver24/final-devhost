import type { Deployment, DeploymentProvider, DeploymentState, DeploymentStatus, ProbeResponse } from './monitor';

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
const asText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const asDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const validPath = (path: string) => /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path) && !path.includes('..');
const publicUrl = (value: string): string => {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) throw new Error('A public HTTPS production URL is required.');
  return url.href;
};

abstract class HttpProvider implements DeploymentProvider {
  protected readonly fetchImpl: typeof fetch;
  protected readonly productionUrl: string;
  protected readonly timeoutMs: number;
  constructor(protected readonly projectId: string, productionUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number) {
    if (!projectId.trim()) throw new Error('A platform project/service ID is required.');
    this.productionUrl = publicUrl(productionUrl);
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.max(1_000, Math.min(timeoutMs ?? 8_000, 20_000));
  }
  protected assertProject(id: string) { if (id !== this.projectId) throw new Error('Provider is scoped to a different project.'); }
  isSafeDeploymentUrl(url: string): boolean { return url === this.productionUrl; }
  protected async probe(url: string, path: string): Promise<ProbeResponse> {
    if (!validPath(path)) throw new Error('Invalid production probe path.');
    try {
      const response = await this.fetchImpl(new URL(path, url), { redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'application/json' } });
      return { result: response.ok ? 'pass' : 'fail', evidence: `HTTP ${response.status} from ${new URL(url).hostname}${path}` };
    } catch { throw new Error('Deployment probe failed or timed out.'); }
  }
  async probeProduction(projectId: string, path: string) { this.assertProject(projectId); return this.probe(this.productionUrl, path); }
  async probeImmutableDeployment(deploymentUrl: string, path: string) { return this.probe(deploymentUrl, path); }
  abstract getProductionDeployment(projectId: string): Promise<Deployment | null>;
  abstract getPreviousDeployment(projectId: string, deploymentId: string): Promise<Deployment | null>;
  abstract rollbackProductionTo(projectId: string, deploymentId: string): Promise<{ actionUrl?: string }>;
}

export interface RenderProviderOptions { accessToken: string; serviceId: string; ownerId: string; productionUrl: string; fetch?: typeof fetch; timeoutMs?: number; }
export class RenderProvider extends HttpProvider {
  constructor(private readonly options: RenderProviderOptions) {
    super(options.serviceId, options.productionUrl, options.fetch, options.timeoutMs);
    if (!options.accessToken.trim() || !options.ownerId.trim()) throw new Error('Render access token and owner ID are required.');
  }
  private async request(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(new URL(path, 'https://api.render.com'), { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${this.options.accessToken}`, Accept: 'application/json', ...init.headers } });
    if (!response.ok) throw new Error(`Render API request failed with HTTP ${response.status}.`);
    return response;
  }
  private map(value: unknown): (Deployment & { state: DeploymentState }) | undefined {
    const wrap = asObject(value); const item = asObject(wrap?.deploy) ?? wrap;
    const id = asText(item?.id); const createdAt = asDate(item?.createdAt); const raw = asText(item?.status)?.toLowerCase();
    if (!id || !createdAt || !raw) return undefined;
    const state: DeploymentState = ['live', 'deactivated'].includes(raw) ? 'READY' : ['build_failed', 'update_failed', 'pre_deploy_failed'].includes(raw) ? 'ERROR' : ['created', 'queued'].includes(raw) ? 'QUEUED' : ['build_in_progress', 'update_in_progress', 'pre_deploy_in_progress'].includes(raw) ? 'BUILDING' : raw === 'canceled' ? 'CANCELED' : 'UNKNOWN';
    const commit = asObject(item?.commit);
    return { id, createdAt, immutableUrl: this.productionUrl, state, ...(asText(commit?.id) ? { commitSha: asText(commit?.id) } : {}) };
  }
  private async deployments() {
    const response = await this.request(`/v1/services/${encodeURIComponent(this.projectId)}/deploys?limit=50`);
    const body = await response.json();
    return (Array.isArray(body) ? body : []).map(item => this.map(item)).filter((item): item is Deployment & { state: DeploymentState } => Boolean(item)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  async getProductionDeployment(id: string) { this.assertProject(id); return (await this.deployments()).find(item => item.state === 'READY') ?? null; }
  async getLatestDeploymentStatus(id: string): Promise<DeploymentStatus | null> { this.assertProject(id); const item = (await this.deployments())[0]; return item ? { id: item.id, state: item.state, createdAt: item.createdAt, immutableUrl: item.immutableUrl, commitSha: item.commitSha } : null; }
  async getPreviousDeployment(id: string, deploymentId: string) { this.assertProject(id); const current = (await this.deployments()).find(item => item.id === deploymentId); return current ? (await this.deployments()).find(item => item.state === 'READY' && item.id !== current.id && Date.parse(item.createdAt) < Date.parse(current.createdAt)) ?? null : null; }
  async rollbackProductionTo(id: string, deploymentId: string) {
    this.assertProject(id); const current = await this.getProductionDeployment(id); const previous = current && await this.getPreviousDeployment(id, current.id);
    if (!current || previous?.id !== deploymentId) throw new Error('Rollback target is not the confirmed immediate predecessor.');
    await this.request(`/v1/services/${encodeURIComponent(this.projectId)}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deployId: deploymentId }) });
    return { actionUrl: this.productionUrl };
  }
  async getDeploymentLogs(id: string, deploymentId: string) {
    this.assertProject(id); const deployment = (await this.deployments()).find(item => item.id === deploymentId);
    const url = new URL('/v1/logs', 'https://api.render.com'); url.searchParams.set('ownerId', this.options.ownerId); url.searchParams.append('resource', this.projectId); url.searchParams.set('limit', '20'); if (deployment) url.searchParams.set('startTime', deployment.createdAt);
    const response = await this.request(`${url.pathname}${url.search}`); const body = asObject(await response.json());
    return (Array.isArray(body?.logs) ? body.logs : []).map(asObject).map(log => asText(log?.message)).filter((line): line is string => Boolean(line));
  }
}

export interface RailwayProviderOptions { token: string; projectId: string; serviceId: string; environmentId?: string; productionUrl: string; fetch?: typeof fetch; timeoutMs?: number; }
export class RailwayProvider extends HttpProvider {
  constructor(private readonly options: RailwayProviderOptions) { super(options.serviceId, options.productionUrl, options.fetch, options.timeoutMs); if (!options.token.trim()) throw new Error('Railway API token is required.'); }
  private async gql(query: string, variables: Json) {
    const response = await this.fetchImpl('https://backboard.railway.com/graphql/v2', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
    const body = asObject(await response.json()); if (!response.ok || (Array.isArray(body?.errors) && body!.errors.length)) throw new Error('Railway API request failed.'); return body?.data;
  }
  private async deployments() {
    const data = asObject(await this.gql('query Deployments($input: DeploymentListInput!) { deployments(input: $input, first: 50) { edges { node { id status createdAt meta } } } }', { input: { projectId: this.options.projectId, serviceId: this.options.serviceId, ...(this.options.environmentId ? { environmentId: this.options.environmentId } : {}) } }));
    const connection = asObject(data?.deployments); const edges = Array.isArray(connection?.edges) ? connection.edges : [];
    return edges.map(asObject).map(edge => asObject(edge?.node)).map(node => {
      const id = asText(node?.id); const createdAt = asDate(node?.createdAt); const raw = asText(node?.status)?.toUpperCase(); if (!id || !createdAt || !raw) return undefined;
      const state: DeploymentState = ['SUCCESS', 'ACTIVE', 'COMPLETED'].includes(raw) ? 'READY' : ['FAILED', 'CRASHED'].includes(raw) ? 'ERROR' : ['QUEUED', 'WAITING', 'INITIALIZING'].includes(raw) ? 'QUEUED' : ['BUILDING', 'DEPLOYING'].includes(raw) ? 'BUILDING' : ['REMOVED', 'REMOVING'].includes(raw) ? 'CANCELED' : 'UNKNOWN';
      const meta = asObject(node?.meta); return { id, createdAt, immutableUrl: this.productionUrl, state, ...(asText(meta?.commitHash) ? { commitSha: asText(meta?.commitHash) } : {}) };
    }).filter((item): item is Deployment & { state: DeploymentState } => Boolean(item)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  async getProductionDeployment(id: string) { this.assertProject(id); return (await this.deployments()).find(item => item.state === 'READY') ?? null; }
  async getLatestDeploymentStatus(id: string): Promise<DeploymentStatus | null> { this.assertProject(id); const item = (await this.deployments())[0]; return item ? { id: item.id, state: item.state, createdAt: item.createdAt, immutableUrl: item.immutableUrl, commitSha: item.commitSha } : null; }
  async getPreviousDeployment(id: string, deploymentId: string) { this.assertProject(id); const all = await this.deployments(); const current = all.find(item => item.id === deploymentId); return current ? all.find(item => item.state === 'READY' && item.id !== current.id && Date.parse(item.createdAt) < Date.parse(current.createdAt)) ?? null : null; }
  async rollbackProductionTo(id: string, deploymentId: string) { this.assertProject(id); const current = await this.getProductionDeployment(id); const previous = current && await this.getPreviousDeployment(id, current.id); if (!current || previous?.id !== deploymentId) throw new Error('Rollback target is not the confirmed immediate predecessor.'); await this.gql('mutation Redeploy($id: String!) { deploymentRedeploy(id: $id) { id } }', { id: deploymentId }); return { actionUrl: this.productionUrl }; }
  async getDeploymentLogs(id: string, deploymentId: string) { this.assertProject(id); const data = asObject(await this.gql('query Logs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { message } }', { deploymentId, limit: 20 })); return (Array.isArray(data?.deploymentLogs) ? data.deploymentLogs : []).map(asObject).map(log => asText(log?.message)).filter((line): line is string => Boolean(line)); }
}

export interface CoolifyProviderOptions { accessToken: string; applicationId: string; baseUrl: string; productionUrl: string; fetch?: typeof fetch; timeoutMs?: number; }
export class CoolifyProvider extends HttpProvider {
  private readonly apiBase: URL;
  constructor(private readonly options: CoolifyProviderOptions) { super(options.applicationId, options.productionUrl, options.fetch, options.timeoutMs); if (!options.accessToken.trim()) throw new Error('Coolify API token is required.'); this.apiBase = new URL('/api/v1/', publicUrl(options.baseUrl)); }
  private async request(path: string, init: RequestInit = {}) { const response = await this.fetchImpl(new URL(path.replace(/^\//, ''), this.apiBase), { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${this.options.accessToken}`, Accept: 'application/json', ...init.headers } }); if (!response.ok) throw new Error(`Coolify API request failed with HTTP ${response.status}.`); return response; }
  private async deployments() { const body = await (await this.request('deployments')).json(); return (Array.isArray(body) ? body : []).map(asObject).filter(item => item?.application_id === this.projectId).map(item => { const id = asText(item?.deployment_uuid); const createdAt = asDate(item?.created_at); const raw = asText(item?.status)?.toLowerCase(); if (!id || !createdAt || !raw) return undefined; const state: DeploymentState = ['finished', 'success', 'successful'].includes(raw) ? 'READY' : ['failed', 'error'].includes(raw) ? 'ERROR' : ['queued', 'pending'].includes(raw) ? 'QUEUED' : ['in_progress', 'running'].includes(raw) ? 'BUILDING' : ['cancelled', 'canceled'].includes(raw) ? 'CANCELED' : 'UNKNOWN'; return { id, createdAt, immutableUrl: this.productionUrl, state, ...(asText(item?.commit) ? { commitSha: asText(item?.commit) } : {}) }; }).filter((item): item is Deployment & { state: DeploymentState } => Boolean(item)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)); }
  async getProductionDeployment(id: string) { this.assertProject(id); return (await this.deployments()).find(item => item.state === 'READY') ?? null; }
  async getLatestDeploymentStatus(id: string): Promise<DeploymentStatus | null> { this.assertProject(id); const item = (await this.deployments())[0]; return item ? { id: item.id, state: item.state, createdAt: item.createdAt, immutableUrl: item.immutableUrl, commitSha: item.commitSha } : null; }
  async getPreviousDeployment(id: string, deploymentId: string) { this.assertProject(id); const all = await this.deployments(); const current = all.find(item => item.id === deploymentId); return current ? all.find(item => item.state === 'READY' && item.id !== current.id && Date.parse(item.createdAt) < Date.parse(current.createdAt)) ?? null : null; }
  async rollbackProductionTo(id: string, deploymentId: string) { this.assertProject(id); const current = await this.getProductionDeployment(id); const previous = current && await this.getPreviousDeployment(id, current.id); if (!current || previous?.id !== deploymentId) throw new Error('Rollback target is not the confirmed immediate predecessor.'); const target = (await this.deployments()).find(item => item.id === deploymentId); if (!target?.commitSha) throw new Error('Coolify rollback target has no image commit/tag.'); await this.request(`applications/${encodeURIComponent(this.projectId)}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commit: target.commitSha }) }); return { actionUrl: this.productionUrl }; }
  async getDeploymentLogs(id: string, deploymentId: string) {
    this.assertProject(id);
    const body = await (await this.request('deployments')).json();
    const deployment = (Array.isArray(body) ? body : []).map(asObject).find(item => item?.application_id === this.projectId && item?.deployment_uuid === deploymentId);
    const logs = asText(deployment?.logs);
    return logs ? logs.split(/\r?\n/).filter(Boolean).slice(-20) : [];
  }
}
