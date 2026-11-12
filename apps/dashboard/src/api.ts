import { parseIncident, parseIncidentList } from './incident';

export class ApiError extends Error {}

export async function readJson(path: string, signal: AbortSignal, fetcher = globalThis.fetch): Promise<unknown> {
  if (!/^\/api\/(?:incidents(?:\/[^/?]+)?|agent\/runs(?:\/[^/?]+)?)$/.test(path)) throw new ApiError('Only read-only incident endpoints are allowed.');
  const timeout = AbortSignal.timeout(8000);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetcher(path, { method: 'GET', signal: combined, headers: { Accept: 'application/json' }, cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new ApiError(response.status === 404
      ? 'The controller could not find this incident. Refresh the list.'
      : `Controller request failed (HTTP ${response.status}). Check the local controller.`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('The controller did not return JSON. Check the API URL and proxy configuration.');
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError('The controller returned an empty response.');
    const decoder = new TextDecoder();
    let body = '';
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > (path.startsWith('/api/agent/runs/') ? 20_000_000 : 1_000_000)) throw new ApiError('The incident response is too large. Ask the controller to bound its output.');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel(); }
    try { return JSON.parse(body); }
    catch { throw new ApiError('The controller returned invalid JSON. Check the incident API.'); }
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeout.aborted) throw new ApiError('The controller timed out. Check that it is running locally.');
    if (error instanceof ApiError) throw error;
    throw new ApiError('The controller is unavailable. Check CONTROLLER_API_URL and start the local controller.');
  }
}

export async function fetchIncidents(signal: AbortSignal, fetcher = globalThis.fetch) {
  const data = await readJson('/api/incidents', signal, fetcher);
  try { return parseIncidentList(data); }
  catch { throw new ApiError('The incident list does not match the README contract. Ask Ronit to check the API response.'); }
}

export async function fetchIncident(id: string, signal: AbortSignal, fetcher = globalThis.fetch) {
  const data = await readJson(`/api/incidents/${encodeURIComponent(id)}`, signal, fetcher);
  try {
    const incident = parseIncident(data);
    if (incident.id !== id) throw new Error('Incident ID mismatch.');
    return incident;
  } catch { throw new ApiError('The incident detail does not match the requested ID or README contract.'); }
}
