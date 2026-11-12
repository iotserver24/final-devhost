import type { IncidentStore } from './incident-store';

export function createIncidentApi(store: Pick<IncidentStore, 'list' | 'get'>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { Allow: 'GET' } });
    }

    if (url.pathname === '/api/incidents') {
      return Response.json(await store.list());
    }

    const match = /^\/api\/incidents\/([^/]+)$/.exec(url.pathname);
    if (match) {
      let id: string;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        return Response.json({ error: 'Invalid incident ID.' }, { status: 400 });
      }
      const incident = await store.get(id);
      return incident
        ? Response.json(incident)
        : Response.json({ error: 'Incident not found.' }, { status: 404 });
    }

    return Response.json({ error: 'Not found.' }, { status: 404 });
  };
}
