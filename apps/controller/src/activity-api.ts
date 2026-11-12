import { timingSafeEqual } from 'node:crypto';
import type { Incident } from '@nexathon/contracts';
import type { ActivityEvent, ActivityHub, ActivityRunDetail, ActivityRunSummary, ActivitySource } from './activity';

const MAX_BODY_BYTES = 1024;
const HEARTBEAT_MS = 15_000;

export interface ActivityApiOptions {
  hub: ActivityHub;
  /** Stored runs survive a controller restart. Memory still wins for a live run. */
  loadRuns?: () => Promise<ActivityRunSummary[]>;
  loadRun?: (id: string) => Promise<ActivityRunDetail | undefined>;
  lookupIncident: (id: string) => Incident | undefined | Promise<Incident | undefined>;
  dispatch: (runId: string, incident: Incident, source: ActivitySource) => void;
  token?: string;
  /** True when dedicated model, E2B and GitHub credentials are configured. */
  aiConfigured: boolean;
}

/** The slice of Bun's server object needed to hold an event stream open. */
interface IdleControl {
  timeout(request: Request, seconds: number): void;
}

function authorized(request: Request, token?: string): boolean {
  // A browser page can never start a run: the token stays in the local CLI environment.
  if (!token || request.headers.has('origin')) return false;
  const received = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function rememberedRun(
  hub: ActivityHub,
  loadRun: ActivityApiOptions['loadRun'],
  id: string,
): Promise<ActivityRunDetail | undefined> {
  const live = hub.get(id);
  if (live) return live;
  const stored = await loadRun?.(id);
  if (!stored) return undefined;
  hub.restore(stored);
  return hub.get(id);
}

function eventFrame(event: ActivityEvent): Uint8Array {
  const data = JSON.stringify(event);
  return new TextEncoder().encode(`id: ${event.seq}\nevent: activity\ndata: ${data}\n\n`);
}

function stream(hub: ActivityHub, runId: string, afterSeq: number, server?: IdleControl, request?: Request): Response {
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      const push = (event: ActivityEvent) => {
        if (closed) return;
        try { controller.enqueue(eventFrame(event)); } catch { close(); }
      };
      unsubscribe = hub.subscribe(runId, afterSeq, push);
      if (!unsubscribe) { close(); return; }
      const status = hub.statusOf(runId);
      if (status === 'completed' || status === 'failed') {
        // A finished run has nothing left to stream; tell the client instead of idling.
        try { controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ status })}\n\n`)); } catch { /* closed */ }
        close();
        return;
      }
      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')); } catch { close(); }
      }, HEARTBEAT_MS);
      if (request && server) server.timeout(request, 0);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Read-only activity feed plus one local-only trigger. Unmatched requests return
 * `undefined` so the incident API can answer them.
 */
export function createActivityApi(options: ActivityApiOptions) {
  const { hub } = options;
  return async (request: Request, server?: IdleControl): Promise<Response | undefined> => {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/agent/runs') {
      const stored = options.loadRuns ? await options.loadRuns() : [];
      const byId = new Map(stored.map(run => [run.id, run]));
      for (const run of hub.list()) byId.set(run.id, run);
      const runs = [...byId.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 50);
      return Response.json(runs, { headers: { 'Cache-Control': 'no-store' } });
    }

    const detail = /^\/api\/agent\/runs\/([a-z0-9-]{1,64})$/.exec(url.pathname);
    if (request.method === 'GET' && detail) {
      const run = await rememberedRun(hub, options.loadRun, detail[1]);
      return run
        ? Response.json(run, { headers: { 'Cache-Control': 'no-store' } })
        : Response.json({ error: 'Run not found.' }, { status: 404 });
    }

    const events = /^\/api\/agent\/runs\/([a-z0-9-]{1,64})\/events$/.exec(url.pathname);
    if (request.method === 'GET' && events) {
      if (!await rememberedRun(hub, options.loadRun, events[1])) return Response.json({ error: 'Run not found.' }, { status: 404 });
      const after = Number(request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0);
      const afterSeq = Number.isSafeInteger(after) && after > 0 ? after : 0;
      return stream(hub, events[1], afterSeq, server, request);
    }

    if (url.pathname === '/api/internal/agent-runs') {
      if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { Allow: 'POST' } });
      if (!authorized(request, options.token)) return Response.json({ error: 'Forbidden.' }, { status: 403 });
      if (!request.headers.get('content-type')?.includes('application/json')) {
        return Response.json({ error: 'Expected application/json.' }, { status: 415 });
      }
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
        return Response.json({ error: 'Request too large.' }, { status: 413 });
      }
      const raw = await request.text();
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
      let input: unknown;
      try { input = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid JSON.' }, { status: 400 }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return Response.json({ error: 'Invalid request.' }, { status: 400 });
      }
      const { incidentId, mode } = input as Record<string, unknown>;
      if (typeof incidentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(incidentId)) {
        return Response.json({ error: 'Invalid incident ID.' }, { status: 400 });
      }
      if (mode !== 'ai' && mode !== 'rehearsal') return Response.json({ error: 'Mode must be ai or rehearsal.' }, { status: 400 });
      const incident = await options.lookupIncident(incidentId);
      if (!incident) return Response.json({ error: 'Incident not found.' }, { status: 404 });
      if (mode === 'ai' && !options.aiConfigured) {
        return Response.json({ error: 'Dedicated model, E2B and GitHub credentials are not configured; enable CONTROLLER_REMEDIATION_ENABLED.' }, { status: 503 });
      }
      if (hub.hasActiveRun()) return Response.json({ error: 'A run is already active.' }, { status: 409 });
      const run = hub.create({ incidentId, source: mode });
      options.dispatch(run.id, incident, mode);
      return Response.json(run, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    }

    return undefined;
  };
}
