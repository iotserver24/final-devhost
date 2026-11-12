import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { appJwt, disconnectFields, githubConnectPage, githubConnectTarget, installationRepositoryNames, matchingVercelProject, verifyGithubWebhook } from '../src/github-app';

describe('github app connect', () => {
  it('builds a manifest that asks for repo and pull request access', () => {
    const page = githubConnectPage('http://127.0.0.1:8899');
    expect(page).toContain('https://github.com/settings/apps/new');
    expect(page).toContain('http://127.0.0.1:8899/api/github/callback');
    expect(page).toContain('pull_requests');
    expect(page).not.toContain('ghp_');
    expect(page).not.toContain('hook_attributes');
  });

  it('points an https app at the webhook', () => {
    const page = githubConnectPage('https://sentinel.example');
    expect(page).toContain('https://sentinel.example/api/github/webhook');
    expect(page).toContain('sentinel-ai-bot');
  });

  it('disconnects access without removing the bot', () => {
    expect(disconnectFields.github).toContain('GITHUB_INSTALLATION_ID');
    expect(disconnectFields.github).not.toContain('GITHUB_APP_PEM');
    expect(disconnectFields.vercel).toContain('VERCEL_ACCESS_TOKEN');
    expect(disconnectFields.vercel).toContain('VERCEL_TEAM_ID');
    expect(disconnectFields.vercel).toContain('VERCEL_PRODUCTION_DOMAIN');
  });

  it('sends setup to the existing bot install page', () => {
    expect(githubConnectTarget('sentinel-ai-bot', '123')).toEqual({ redirect: 'https://github.com/apps/sentinel-ai-bot/installations/new' });
    expect('error' in githubConnectTarget(undefined, '123')).toBe(true);
  });

  it('reads installation repositories and matches a Vercel domain', () => {
    expect(installationRepositoryNames({ repositories: [{ full_name: 'Ronit-Pai/testsite' }, { full_name: 'bad' }] })).toEqual(['Ronit-Pai/testsite']);
    const projects = [{ id: 'prj_1', name: 'testsite', domains: ['testsite-three-iota.vercel.app'] }];
    expect(matchingVercelProject(projects, 'testsite-three-iota.vercel.app')).toBe('prj_1');
    expect(matchingVercelProject(projects, 'other.example')).toBeNull();
  });

  it('checks the GitHub webhook signature', () => {
    const body = '{"zen":"ok"}';
    const secret = 'test-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyGithubWebhook(body, signature, secret)).toBe(true);
    expect(verifyGithubWebhook(body, signature, 'other')).toBe(false);
  });

  it('signs an app JWT with the app id as issuer', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const token = appJwt('12345', pem, Date.parse('2026-10-23T12:00:00Z'));
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.iss).toBe('12345');
    expect(token.split('.')).toHaveLength(3);
  });
});
