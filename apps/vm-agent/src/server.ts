import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Restricted VM agent. It records two image tags for one application and can
 * start the previous tag once. It has no shell and no Docker socket.
 */

export interface DeploymentRecord {
  id: string;
  image: string;
  deployedAt: string;
  healthy: boolean;
}

export interface VmAgentState {
  current: DeploymentRecord;
  previous: DeploymentRecord | null;
  rolledBack: boolean;
  logs: string[];
}

const MAX_LOG_LINES = 40;

export function initialVmState(): VmAgentState {
  return {
    current: {
      id: 'dpl-broken',
      image: 'sentinel-demo-app:broken',
      deployedAt: '2026-11-14T10:00:00.000Z',
      healthy: false,
    },
    previous: {
      id: 'dpl-good',
      image: 'sentinel-demo-app:good',
      deployedAt: '2026-11-14T09:00:00.000Z',
      healthy: true,
    },
    rolledBack: false,
    logs: [
      'current image sentinel-demo-app:broken failed its health check',
      'previous image sentinel-demo-app:good is recorded',
    ],
  };
}

function authorized(header: string | null, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function clampLines(value: string | null): number {
  const parsed = Number(value ?? MAX_LOG_LINES);
  if (!Number.isFinite(parsed)) return MAX_LOG_LINES;
  return Math.max(1, Math.min(Math.trunc(parsed), 200));
}

export async function handleVmRequest(request: Request, state: VmAgentState, application: string, token: string): Promise<Response> {
  if (!authorized(request.headers.get('authorization'), token)) return json(401, { error: 'Unauthorized.' });
  const url = new URL(request.url);
  const prefix = `/v1/apps/${encodeURIComponent(application)}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return json(404, { error: 'Application is not allowlisted.' });
  const action = url.pathname.slice(prefix.length) || '/';

  if (request.method === 'GET' && action === '/status') {
    return json(200, {
      current: state.current,
      ...(state.previous ? { previous: { id: state.previous.id, image: state.previous.image, deployedAt: state.previous.deployedAt } } : {}),
    });
  }
  if (request.method === 'GET' && action === '/health') {
    return json(state.current.healthy ? 200 : 503, { ok: state.current.healthy, image: state.current.image });
  }
  if (request.method === 'GET' && action === '/logs') {
    return json(200, { lines: state.logs.slice(-clampLines(url.searchParams.get('lines'))) });
  }
  if (request.method === 'POST' && action === '/rollback') {
    if (state.rolledBack) return json(409, { error: 'A rollback was already performed for this application.' });
    let target = '';
    try {
      const body = JSON.parse(await request.text()) as { target?: unknown };
      target = typeof body.target === 'string' ? body.target : '';
    } catch {
      return json(400, { error: 'Rollback body must be JSON.' });
    }
    if (!state.previous || target !== state.previous.id) {
      return json(409, { error: 'Rollback target is not the recorded previous deployment.' });
    }
    const restored = { ...state.previous, healthy: true };
    state.previous = { ...state.current, healthy: false };
    state.current = restored;
    state.rolledBack = true;
    state.logs.push(`Rolled back to ${restored.image}`);
    state.logs.splice(0, Math.max(0, state.logs.length - MAX_LOG_LINES));
    return json(200, { ok: true, current: restored.id, image: restored.image });
  }
  return json(404, { error: 'Unknown agent route.' });
}

export function startVmAgent(options: {
  token: string;
  application: string;
  hostname?: string;
  port?: number;
  state?: VmAgentState;
}): ReturnType<typeof Bun.serve> {
  if (!options.token || !options.application) throw new Error('VM agent requires an application name and a bearer token.');
  const state = options.state ?? initialVmState();
  return Bun.serve({
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? 0,
    fetch(request) {
      return handleVmRequest(request, state, options.application, options.token);
    },
  });
}

if (import.meta.main) {
  const token = process.env.VM_AGENT_TOKEN?.trim() ?? '';
  const application = process.env.VM_APPLICATION?.trim() || 'taskflow';
  const port = Number(process.env.VM_AGENT_PORT || 8443);
  const hostname = process.env.VM_AGENT_HOST?.trim() || '127.0.0.1';
  if (!token) throw new Error('VM_AGENT_TOKEN is required.');
  const server = startVmAgent({ token, application, hostname, port });
  console.log(`VM agent listening on ${server.hostname}:${server.port} for ${application}`);
}
