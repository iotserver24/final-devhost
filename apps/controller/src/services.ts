import { createHash } from 'node:crypto';
import type { IncidentStore } from './incident-store';

export type ServiceRole = 'app' | 'dependency';

export interface WatchedService {
  id: string;
  name: string;
  repository: string;
  vercelProjectId: string;
  teamId?: string;
  productionHost: string;
  probePath: string;
  role: ServiceRole;
  enabled: boolean;
  sentryProject?: string;
  posthogProject?: string;
  createdAt: string;
}

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const hostPattern = /^[a-z0-9.-]+$/;
const probePattern = /^\/(?!\/)[A-Za-z0-9/_-]*$/;

export function serviceIdFor(projectId: string): string {
  return `svc-${createHash('sha256').update(projectId).digest('hex').slice(0, 12)}`;
}

export function parseWatchedService(input: unknown, now = new Date().toISOString()): WatchedService | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'Expected a service object.' };
  const body = input as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const repository = String(body.repository ?? '').trim();
  const vercelProjectId = String(body.vercelProjectId ?? '').trim();
  const productionHost = String(body.productionHost ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const probePath = String(body.probePath ?? '/api/tasks').trim() || '/api/tasks';
  const role = body.role === 'dependency' ? 'dependency' : body.role === 'app' ? 'app' : '';
  if (!name || name.length > 80) return { error: 'Name is required.' };
  if (!repoPattern.test(repository)) return { error: 'Repository must look like owner/name.' };
  if (!vercelProjectId || vercelProjectId.length > 80) return { error: 'Vercel project id is required.' };
  if (!hostPattern.test(productionHost)) return { error: 'Production host must be a hostname.' };
  if (!probePattern.test(probePath) || probePath.includes('..')) return { error: 'Probe path must be a safe absolute path.' };
  if (!role) return { error: 'Role must be app or dependency.' };
  const teamId = typeof body.teamId === 'string' && body.teamId.trim() ? body.teamId.trim() : undefined;
  const sentryProject = typeof body.sentryProject === 'string' && body.sentryProject.trim() ? body.sentryProject.trim() : undefined;
  const posthogProject = typeof body.posthogProject === 'string' && body.posthogProject.trim() ? body.posthogProject.trim() : undefined;
  const id = typeof body.id === 'string' && /^svc-[a-z0-9-]{4,40}$/.test(body.id) ? body.id : serviceIdFor(vercelProjectId);
  return {
    id, name, repository, vercelProjectId, productionHost, probePath, role,
    enabled: body.enabled !== false,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : now,
    ...(teamId ? { teamId } : {}),
    ...(sentryProject ? { sentryProject } : {}),
    ...(posthogProject ? { posthogProject } : {}),
  };
}

/** Keep the current single-target watch when no service rows exist yet. */
export async function ensureLegacyWatchedService(store: Pick<IncidentStore, 'listWatchedServices' | 'saveWatchedService'>): Promise<void> {
  const existing = await store.listWatchedServices();
  if (existing.length > 0) return;
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  const repository = process.env.REMEDIATOR_REPOSITORY?.trim();
  const host = process.env.VERCEL_PRODUCTION_DOMAIN?.trim().toLowerCase();
  if (!projectId || !repository || !host || !repoPattern.test(repository)) return;
  const service = parseWatchedService({
    name: repository.split('/')[1] || 'app',
    repository,
    vercelProjectId: projectId,
    teamId: process.env.VERCEL_TEAM_ID,
    productionHost: host,
    probePath: process.env.CONTROLLER_PROBE_PATH || '/api/tasks',
    role: 'app',
    sentryProject: process.env.SENTRY_PROJECT,
    posthogProject: process.env.POSTHOG_PROJECT_ID,
  });
  if ('error' in service) return;
  await store.saveWatchedService(service);
}
