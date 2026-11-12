import { createHmac, createSign, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncidentStore } from './incident-store';

const state = randomBytes(16).toString('hex');

export function githubConnectPage(origin: string, owner?: string): string {
  const redirect = `${origin}/api/github/callback`;
  const manifest = {
    name: 'sentinel-ai-bot',
    url: origin,
    redirect_url: redirect,
    callback_urls: [redirect],
    setup_url: `${origin}/api/github/installed`,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: origin.startsWith('https://') ? ['push', 'pull_request'] : [],
    request_oauth_on_install: false,
    ...(origin.startsWith('https://') ? { hook_attributes: { url: `${origin}/api/github/webhook`, active: true } } : {}),
  };
  const target = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  const json = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Connect GitHub</title>
<p>GitHub will ask you to create the Sentinel app, then install it on the repository.</p>
<form method="post" action="${target}"><input type="hidden" name="state" value="${state}">
<input type="hidden" name="manifest" value='${json.replaceAll("'", '&#39;')}'>
<button type="submit">Continue to GitHub</button></form><script>document.forms[0].submit()</script>`;
}

export function githubStateOk(value: string | null): boolean {
  return value === state;
}

export async function exchangeGithubManifest(code: string): Promise<Record<string, string>> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sentinel' },
  });
  if (!response.ok) throw new Error('GitHub did not finish creating the app.');
  const body = await response.json() as { id?: number; pem?: string; slug?: string; client_id?: string; webhook_secret?: string };
  if (!body.id || !body.pem || !body.slug) throw new Error('GitHub app details were incomplete.');
  return {
    GITHUB_APP_ID: String(body.id),
    GITHUB_APP_PEM: body.pem,
    GITHUB_APP_SLUG: body.slug,
    ...(body.client_id ? { GITHUB_CLIENT_ID: body.client_id } : {}),
    ...(body.webhook_secret ? { GITHUB_WEBHOOK_SECRET: body.webhook_secret } : {}),
  };
}

export function verifyGithubWebhook(body: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith('sha256=') || !secret) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const received = signature.slice('sha256='.length);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const key = pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const issued = Math.floor(now / 1000);
  const payload = base64url(JSON.stringify({ iat: issued - 60, exp: issued + 540, iss: appId }));
  const data = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return `${data}.${signer.sign(key).toString('base64url')}`;
}

export const disconnectFields = {
  github: ['GITHUB_INSTALLATION_ID', 'REMEDIATOR_REPOSITORY', 'REMEDIATOR_ALLOWED_REPOSITORY'],
  vercel: ['VERCEL_ACCESS_TOKEN', 'VERCEL_REFRESH_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'CONTROLLER_ROLLBACK_PROJECT_ID', 'VERCEL_PRODUCTION_DOMAIN', 'CONTROLLER_PROBE_PATH'],
} as const;

export function githubConnectTarget(slug: string | undefined, appId: string | undefined): { redirect: string } | { error: string } {
  if (!slug || !appId || !/^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/.test(slug)) {
    return { error: 'The GitHub app is not configured. Add the existing bot before giving access.' };
  }
  return { redirect: `https://github.com/apps/${slug}/installations/new` };
}

export function installationRepositoryNames(payload: unknown): string[] {
  const repos = payload && typeof payload === 'object' && 'repositories' in payload
    ? (payload as { repositories?: unknown }).repositories
    : undefined;
  if (!Array.isArray(repos)) return [];
  return repos.flatMap(repo => {
    if (!repo || typeof repo !== 'object' || !('full_name' in repo)) return [];
    const name = (repo as { full_name?: unknown }).full_name;
    return typeof name === 'string' && /^[^/\s]+\/[^/\s]+$/.test(name) ? [name] : [];
  });
}

export function matchingVercelProject(projects: { id: string; name: string; domains: string[] }[], host: string): string | null {
  const wanted = host.trim().toLowerCase();
  if (!wanted) return null;
  const match = projects.find(project => project.domains.some(domain => domain.toLowerCase() === wanted));
  return match?.id ?? null;
}

export async function installationExists(appId: string, pem: string, installationId: string): Promise<boolean> {
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${appJwt(appId, pem)}`, 'User-Agent': 'sentinel' },
  });
  return response.ok;
}

export async function listInstallationRepositories(appId: string, pem: string, installationId: string): Promise<string[]> {
  const token = await installationToken(appId, pem, installationId, 'read');
  const names: string[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'sentinel' },
    });
    if (!response.ok) throw new Error('GitHub did not list the installation repositories.');
    const body = await response.json() as { total_count?: number };
    const pageNames = installationRepositoryNames(body);
    names.push(...pageNames);
    const total = body.total_count;
    if (pageNames.length < 100 || (typeof total === 'number' && names.length >= total)) break;
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

export async function installationToken(appId: string, pem: string, installationId: string, access: 'read' | 'write'): Promise<string> {
  const permissions = access === 'write'
    ? { contents: 'write', pull_requests: 'write', metadata: 'read' }
    : { contents: 'read', metadata: 'read' };
  const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${appJwt(appId, pem)}`,
      'User-Agent': 'sentinel',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permissions }),
  });
  if (!response.ok) throw new Error('GitHub did not issue an installation token.');
  const body = await response.json() as { token?: string };
  if (!body.token) throw new Error('GitHub did not issue an installation token.');
  return body.token;
}

/** Prefer a short-lived GitHub App token. Fall back to a saved personal token. */
export async function githubCredentials(store: Pick<IncidentStore, 'readSettings'>): Promise<{ write?: string; read?: string }> {
  const saved = await store.readSettings();
  const appId = saved.GITHUB_APP_ID || process.env.GITHUB_APP_ID;
  const pem = saved.GITHUB_APP_PEM || process.env.GITHUB_APP_PEM;
  const installationId = saved.GITHUB_INSTALLATION_ID || process.env.GITHUB_INSTALLATION_ID;
  if (appId && pem && installationId) {
    const [write, read] = await Promise.all([
      installationToken(appId, pem, installationId, 'write'),
      installationToken(appId, pem, installationId, 'read'),
    ]);
    return { write, read };
  }
  return {
    ...(process.env.GH_TOKEN ? { write: process.env.GH_TOKEN } : {}),
    ...(process.env.GITHUB_READ_TOKEN ? { read: process.env.GITHUB_READ_TOKEN } : {}),
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}
