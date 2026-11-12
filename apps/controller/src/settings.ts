import type { IncidentStore } from './incident-store';

export interface SettingField {
  group: string;
  key: string;
  label: string;
  secret: boolean;
  hidden?: boolean;
  /** Set in the dashboard. Never filled from the controller environment. */
  clientOwned?: boolean;
}

export const settingFields: SettingField[] = [
  { group: 'Platform', key: 'CONTROLLER_PLATFORM', label: 'Platform (vercel, railway, render, coolify)', secret: false },
  { group: 'Vercel', key: 'VERCEL_ACCESS_TOKEN', label: 'Access token (filled by Connect Vercel)', secret: true },
  { group: 'Vercel', key: 'VERCEL_REFRESH_TOKEN', label: 'Refresh token', secret: true },
  { group: 'Vercel', key: 'VERCEL_TEAM_ID', label: 'Team id', secret: false, hidden: true, clientOwned: true },
  { group: 'Vercel', key: 'VERCEL_PROJECT_ID', label: 'Project id', secret: false, clientOwned: true },
  { group: 'Vercel', key: 'CONTROLLER_ROLLBACK_PROJECT_ID', label: 'Rollback project id', secret: false, hidden: true, clientOwned: true },
  { group: 'Vercel', key: 'VERCEL_PRODUCTION_DOMAIN', label: 'Public site link (host only)', secret: false, clientOwned: true },
  { group: 'Vercel', key: 'CONTROLLER_PROBE_PATH', label: 'Probe path', secret: false, clientOwned: true },
  { group: 'Vercel', key: 'CONTROLLER_MONITOR_ENABLED', label: 'Monitoring (true/false)', secret: false },
  { group: 'Vercel', key: 'CONTROLLER_ROLLBACK_ENABLED', label: 'Rollback (true/false)', secret: false },
  { group: 'Railway', key: 'RAILWAY_TOKEN', label: 'API token', secret: true },
  { group: 'Railway', key: 'RAILWAY_PROJECT_ID', label: 'Project id', secret: false },
  { group: 'Railway', key: 'RAILWAY_SERVICE_ID', label: 'Service id', secret: false },
  { group: 'Railway', key: 'RAILWAY_ENVIRONMENT_ID', label: 'Environment id (optional)', secret: false },
  { group: 'Railway', key: 'RAILWAY_PRODUCTION_URL', label: 'Public production URL', secret: false },
  { group: 'Render', key: 'RENDER_API_KEY', label: 'API key', secret: true },
  { group: 'Render', key: 'RENDER_OWNER_ID', label: 'Workspace owner id', secret: false },
  { group: 'Render', key: 'RENDER_SERVICE_ID', label: 'Service id', secret: false },
  { group: 'Render', key: 'RENDER_PRODUCTION_URL', label: 'Public production URL', secret: false },
  { group: 'Coolify', key: 'COOLIFY_API_TOKEN', label: 'API token', secret: true },
  { group: 'Coolify', key: 'COOLIFY_BASE_URL', label: 'Coolify base URL', secret: false },
  { group: 'Coolify', key: 'COOLIFY_APPLICATION_ID', label: 'Application UUID', secret: false },
  { group: 'Coolify', key: 'COOLIFY_PRODUCTION_URL', label: 'Public production URL', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_ID', label: 'App id (filled by Connect GitHub)', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_SLUG', label: 'App slug', secret: false },
  { group: 'GitHub', key: 'GITHUB_INSTALLATION_ID', label: 'Installation id', secret: false },
  { group: 'GitHub', key: 'GITHUB_APP_PEM', label: 'App private key', secret: true },
  { group: 'GitHub', key: 'GITHUB_WEBHOOK_SECRET', label: 'Webhook secret', secret: true },
  { group: 'GitHub', key: 'GH_TOKEN', label: 'Personal token fallback for pull requests', secret: true },
  { group: 'GitHub', key: 'GITHUB_READ_TOKEN', label: 'Personal read-token fallback', secret: true },
  { group: 'GitHub', key: 'REMEDIATOR_REPOSITORY', label: 'Repository (owner/name)', secret: false, clientOwned: true },
  { group: 'GitHub', key: 'REMEDIATOR_ALLOWED_REPOSITORY', label: 'Allowed repository', secret: false, hidden: true, clientOwned: true },
  { group: 'Sandbox', key: 'E2B_API_KEY', label: 'E2B API key', secret: true },
  { group: 'Sandbox', key: 'E2B_REMEDIATOR_TEMPLATE', label: 'E2B template', secret: false },
  { group: 'Sandbox', key: 'CONTROLLER_REMEDIATION_ENABLED', label: 'Remediation (true/false)', secret: false },
  { group: 'Model', key: 'REMEDIATOR_MODEL_API_KEY', label: 'Model API key', secret: true },
  { group: 'Model', key: 'REMEDIATOR_MODEL_ID', label: 'Model id', secret: false },
  { group: 'Model', key: 'REMEDIATOR_MODEL_BASE_URL', label: 'Model base URL', secret: false },
  { group: 'Email', key: 'SMTP_FROM', label: 'From address', secret: false },
  { group: 'Email', key: 'SMTP_TO', label: 'To address', secret: false },
];

const allowed = new Set(settingFields.map(field => field.key));

const clientOwned = new Set(settingFields.filter(field => field.clientOwned).map(field => field.key));

export async function applyStoredSettings(store: Pick<IncidentStore, 'readSettings'>): Promise<void> {
  const saved = await store.readSettings();
  for (const key of clientOwned) {
    if (saved[key]) process.env[key] = saved[key];
    else delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (allowed.has(key) && !clientOwned.has(key) && value) process.env[key] = value;
  }
}

export function createSettingsApi(store: Pick<IncidentStore, 'readSettings' | 'writeSettings' | 'deleteSettings'>) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== '/api/settings') return null;
    if (request.method === 'GET') {
      const saved = await store.readSettings();
      return Response.json({
        restartRequired: true,
        fields: settingFields.filter(field => !field.hidden).map(field => {
          const value = saved[field.key] || (field.clientOwned ? '' : process.env[field.key] || '');
          return {
            ...field,
            configured: Boolean(value),
            source: saved[field.key] ? 'saved' : value ? 'environment' : 'missing',
            value: field.secret ? '' : value,
          };
        }),
      });
    }
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: 'Settings body must be JSON.' }, { status: 400 }); }
    const incoming = body && typeof body === 'object' && 'values' in body ? (body as { values?: unknown }).values : undefined;
    if (!incoming || typeof incoming !== 'object') return Response.json({ error: 'Expected { values }.' }, { status: 400 });
    const next: Record<string, string> = {};
    const clear: string[] = [];
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key) || typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) next[key] = trimmed;
      else if (clientOwned.has(key)) clear.push(key);
    }
    if (next.VERCEL_PRODUCTION_DOMAIN) {
      const raw = next.VERCEL_PRODUCTION_DOMAIN;
      if (raw.includes('://') || raw.includes('/')) {
        try {
          const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
          next.VERCEL_PRODUCTION_DOMAIN = url.hostname;
          if (url.pathname && url.pathname !== '/') next.CONTROLLER_PROBE_PATH = url.pathname;
        } catch { /* keep the typed value */ }
      }
    }
    if (next.REMEDIATOR_REPOSITORY) next.REMEDIATOR_ALLOWED_REPOSITORY = next.REMEDIATOR_REPOSITORY;
    if (next.VERCEL_PROJECT_ID) next.CONTROLLER_ROLLBACK_PROJECT_ID = next.VERCEL_PROJECT_ID;
    if (next.RAILWAY_SERVICE_ID) next.CONTROLLER_ROLLBACK_PROJECT_ID = next.RAILWAY_SERVICE_ID;
    if (next.RENDER_SERVICE_ID) next.CONTROLLER_ROLLBACK_PROJECT_ID = next.RENDER_SERVICE_ID;
    if (next.COOLIFY_APPLICATION_ID) next.CONTROLLER_ROLLBACK_PROJECT_ID = next.COOLIFY_APPLICATION_ID;
    if (Object.keys(next).length) await store.writeSettings(next);
    if (clear.length) await store.deleteSettings(clear);
    return Response.json({ ok: true, saved: Object.keys(next), cleared: clear, restartRequired: true });
  };
}
