const VERCEL_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp';

export interface VercelDevice {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export async function startVercelDevice(): Promise<VercelDevice> {
  const discovery = await fetch('https://vercel.com/.well-known/openid-configuration');
  if (!discovery.ok) throw new Error('Vercel sign-in is unavailable.');
  const config = await discovery.json() as { device_authorization_endpoint?: string; token_endpoint?: string };
  if (!config.device_authorization_endpoint || !config.token_endpoint) throw new Error('Vercel sign-in is unavailable.');
  const response = await fetch(config.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: VERCEL_CLIENT_ID, scope: 'openid offline_access' }),
  });
  if (!response.ok) throw new Error('Vercel did not start sign-in.');
  const body = await response.json() as {
    device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number;
  };
  if (!body.device_code || !body.user_code) throw new Error('Vercel did not start sign-in.');
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: `https://vercel.com/oauth/device?user_code=${encodeURIComponent(body.user_code)}`,
    intervalMs: Math.max(5, body.interval ?? 5) * 1000,
    expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
    tokenEndpoint: config.token_endpoint,
  } as VercelDevice & { tokenEndpoint: string };
}

export async function pollVercelDevice(deviceCode: string): Promise<{ pending?: boolean; accessToken?: string; refreshToken?: string }> {
  const discovery = await fetch('https://vercel.com/.well-known/openid-configuration');
  if (!discovery.ok) throw new Error('Vercel sign-in is unavailable.');
  const config = await discovery.json() as { token_endpoint?: string };
  if (!config.token_endpoint) throw new Error('Vercel sign-in is unavailable.');
  const response = await fetch(config.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: VERCEL_CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }),
  });
  const body = await response.json() as { error?: string; access_token?: string; refresh_token?: string };
  if (body.error === 'authorization_pending' || body.error === 'slow_down') return { pending: true };
  if (!response.ok || !body.access_token) throw new Error('Vercel sign-in was not completed.');
  return { accessToken: body.access_token, ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}) };
}
