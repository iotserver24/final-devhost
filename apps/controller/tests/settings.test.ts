import { describe, expect, it } from 'bun:test';
import { IncidentStore } from '../src/incident-store';
import { applyStoredSettings, createSettingsApi } from '../src/settings';

describe('integration settings', () => {
  it('stores website values and applies them over the environment on startup', async () => {
    const store = new IncidentStore(':memory:');
    const api = createSettingsApi(store);
    const saved = await api(new Request('http://127.0.0.1/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: {
        SMTP_HOST: 'mail.example.com', SMTP_FROM: 'sentinel@example.com', SMTP_TO: 'judge@example.com',
        VERCEL_ACCESS_TOKEN: 'secret-token', IGNORED: 'nope',
      } }),
    }));
    expect(saved?.status).toBe(200);
    const savedBody = await saved!.json() as { saved: string[] };
    expect(savedBody.saved).toContain('SMTP_TO');
    expect(savedBody.saved).not.toContain('SMTP_HOST');
    expect((await store.readSettings()).VERCEL_ACCESS_TOKEN).toBe('secret-token');
    expect((await store.readSettings()).IGNORED).toBeUndefined();
    const view = await api(new Request('http://127.0.0.1/api/settings'));
    const body = await view!.json() as { fields: Array<{ key: string; value: string; configured: boolean }> };
    const token = body.fields.find(field => field.key === 'VERCEL_ACCESS_TOKEN');
    const host = body.fields.find(field => field.key === 'SMTP_HOST');
    const to = body.fields.find(field => field.key === 'SMTP_TO');
    expect(token?.configured).toBe(true);
    expect(token?.value).toBe('');
    expect(host).toBeUndefined();
    expect(to?.value).toBe('judge@example.com');
    expect((await store.readSettings()).SMTP_TO).toBe('judge@example.com');
    await store.deleteSettings(['VERCEL_ACCESS_TOKEN']);
    expect((await store.readSettings()).VERCEL_ACCESS_TOKEN).toBeUndefined();
    expect((await store.readSettings()).SMTP_TO).toBe('judge@example.com');
    store.close();
  });

  it('uses reconnected Vercel credentials instead of an expired host token after restart', async () => {
    const store = new IncidentStore(':memory:');
    const before = process.env.VERCEL_ACCESS_TOKEN;
    const previousTemplate = process.env.E2B_REMEDIATOR_TEMPLATE;
    try {
      process.env.VERCEL_ACCESS_TOKEN = 'expired-host-token';
      process.env.E2B_REMEDIATOR_TEMPLATE = 'old-template';
      await store.writeSettings({ VERCEL_ACCESS_TOKEN: 'reconnected-token', E2B_REMEDIATOR_TEMPLATE: 'working-template' });
      await applyStoredSettings(store);
      expect(process.env.VERCEL_ACCESS_TOKEN).toBe('reconnected-token');
      expect(process.env.E2B_REMEDIATOR_TEMPLATE).toBe('working-template');
      const response = await createSettingsApi(store)(new Request('http://localhost/api/settings'));
      const body = await response!.json();
      const field = body.fields.find((item: { key: string }) => item.key === 'VERCEL_ACCESS_TOKEN');
      expect(field.source).toBe('saved');
      expect(field.value).toBe('');
    } finally {
      if (before === undefined) delete process.env.VERCEL_ACCESS_TOKEN;
      else process.env.VERCEL_ACCESS_TOKEN = before;
      if (previousTemplate === undefined) delete process.env.E2B_REMEDIATOR_TEMPLATE;
      else process.env.E2B_REMEDIATOR_TEMPLATE = previousTemplate;
      store.close();
    }
  });

  it('uses the explicitly connected GitHub app installation instead of stale host credentials', async () => {
    const store = new IncidentStore(':memory:');
    const keys = ['GITHUB_APP_ID', 'GITHUB_APP_PEM', 'GITHUB_INSTALLATION_ID'] as const;
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = 'old';
      await store.writeSettings({ GITHUB_APP_ID: 'app', GITHUB_APP_PEM: 'pem', GITHUB_INSTALLATION_ID: 'installation' });
      await applyStoredSettings(store);
      expect(process.env.GITHUB_APP_ID).toBe('app');
      expect(process.env.GITHUB_APP_PEM).toBe('pem');
      expect(process.env.GITHUB_INSTALLATION_ID).toBe('installation');
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      store.close();
    }
  });

  it('keeps a host environment value ahead of a saved dashboard value', async () => {
    const store = new IncidentStore(':memory:');
    await store.writeSettings({ CONTROLLER_REMEDIATION_ENABLED: 'false', SMTP_TO: 'judge@example.com' });
    const previousRemediation = process.env.CONTROLLER_REMEDIATION_ENABLED;
    const previousSmtp = process.env.SMTP_TO;
    process.env.CONTROLLER_REMEDIATION_ENABLED = 'true';
    delete process.env.SMTP_TO;
    await applyStoredSettings(store);
    expect(process.env.CONTROLLER_REMEDIATION_ENABLED).toBe('true');
    const env = process.env as Record<string, string | undefined>;
    expect(env.SMTP_TO).toBe('judge@example.com');
    if (previousRemediation === undefined) delete process.env.CONTROLLER_REMEDIATION_ENABLED;
    else process.env.CONTROLLER_REMEDIATION_ENABLED = previousRemediation;
    if (previousSmtp === undefined) delete process.env.SMTP_TO;
    else process.env.SMTP_TO = previousSmtp;
    store.close();
  });
});
