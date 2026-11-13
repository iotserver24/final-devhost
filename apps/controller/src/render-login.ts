// Device login copied from the Render CLI (render-oss/cli pkg/client/oauth).
// The public CLI client id starts a grant; the dashboard shows a code; polling
// returns a bearer token the logs and rollback calls already send as
// Authorization: Bearer. RENDER_API_KEY still wins when it is set, same as the CLI.

const RENDER_CLIENT_ID = '429024F5E608930E2A65EF92591A25CC';
const RENDER_API = 'https://api.render.com/v1';

export interface RenderDevice {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export interface RenderOwner {
  id: string;
  name: string;
}

interface DeviceGrant {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

async function postJson<T>(path: string, body: Record<string, string>): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  const response = await fetch(`${RENDER_API}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'sentinel-controller (render-cli-device)',
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({})) as T & { error?: string };
  return { ok: response.ok, status: response.status, body: parsed };
}

export async function startRenderDevice(): Promise<RenderDevice> {
  const result = await postJson<DeviceGrant>('/device-grant', { client_id: RENDER_CLIENT_ID });
  const grant = result.body;
  if (!result.ok || !grant.device_code || !grant.user_code) throw new Error('Render did not start sign-in.');
  const verificationUri = grant.verification_uri_complete
    || (grant.verification_uri ? `${grant.verification_uri}?user_code=${encodeURIComponent(grant.user_code)}` : `https://dashboard.render.com/device?user_code=${encodeURIComponent(grant.user_code)}`);
  return {
    deviceCode: grant.device_code,
    userCode: grant.user_code,
    verificationUri,
    intervalMs: Math.max(5, grant.interval ?? 5) * 1000,
    expiresAt: Date.now() + (grant.expires_in ?? 600) * 1000,
  };
}

export async function pollRenderDevice(deviceCode: string): Promise<{ pending?: boolean; accessToken?: string; refreshToken?: string; expiresIn?: number }> {
  const result = await postJson<{ access_token?: string; refresh_token?: string; expires_in?: number }>('/device-token', {
    client_id: RENDER_CLIENT_ID,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });
  if (result.body.error === 'authorization_pending' || result.body.error === 'slow_down') return { pending: true };
  if (!result.ok || !result.body.access_token) throw new Error('Render sign-in was not completed.');
  return {
    accessToken: result.body.access_token,
    ...(result.body.refresh_token ? { refreshToken: result.body.refresh_token } : {}),
    ...(result.body.expires_in ? { expiresIn: result.body.expires_in } : {}),
  };
}

export async function listRenderOwners(accessToken: string): Promise<RenderOwner[]> {
  const response = await fetch(`${RENDER_API}/owners?limit=20`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []) as unknown;
  const rows = Array.isArray(body) ? body : [];
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const owner = 'owner' in row && row.owner && typeof row.owner === 'object' ? row.owner as { id?: unknown; name?: unknown; email?: unknown } : row as { id?: unknown; name?: unknown; email?: unknown };
    const id = typeof owner.id === 'string' ? owner.id : '';
    const name = typeof owner.name === 'string' ? owner.name : typeof owner.email === 'string' ? owner.email : id;
    return id ? [{ id, name }] : [];
  });
}
