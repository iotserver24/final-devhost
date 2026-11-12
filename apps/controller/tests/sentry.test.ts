import { describe, expect, test } from 'bun:test';
import { SentryClient, sentryFromEnvironment } from '../src/sentry';

const options = { org: 'acme', project: 'web', token: 'sentry-token', baseUrl: 'https://sentry.example.test' };

function transport(response: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('Sentry integration', () => {
  test('is not configured without credentials and reports honestly', async () => {
    const client = new SentryClient({});
    expect(client.configured()).toBe(false);
    const evidence = await client.recentIssues();
    expect(evidence).toMatchObject({ configured: false, ok: false, issues: [] });
  });

  test('maps unresolved issues into bounded evidence', async () => {
    const { fetchImpl, calls } = transport(() => Response.json([
      { id: '1', shortId: 'WEB-1', title: 'TypeError in checkout', level: 'error', count: 12, lastSeen: '2026-03-01T11:00:00Z' },
      { id: '2', title: 'Timeout listing tasks', level: 'warning', count: 3 },
      { nonsense: true },
    ]));
    const client = new SentryClient({ ...options, fetchImpl });
    const evidence = await client.recentIssues();
    expect(evidence.ok).toBe(true);
    expect(evidence.issues).toHaveLength(2);
    expect(evidence.issues[0]).toMatchObject({ id: '1', shortId: 'WEB-1', count: 12 });
    // Token travels in the Authorization header, never the URL.
    expect(calls[0]!.headers.Authorization).toBe('Bearer sentry-token');
    expect(calls[0]!.url).not.toContain('sentry-token');
    expect(calls[0]!.url).toContain('is%3Aunresolved');
  });

  test('evidence lines are human readable and bounded', async () => {
    const { fetchImpl } = transport(() => Response.json([
      { id: '1', shortId: 'WEB-1', title: 'TypeError in checkout', level: 'error', count: 1 },
    ]));
    const lines = await new SentryClient({ ...options, fetchImpl }).evidenceLines();
    expect(lines).toEqual(['Sentry WEB-1: TypeError in checkout (error, 1 event)']);
  });

  test('rate limits and API errors degrade to no evidence', async () => {
    const limited = transport(() => Response.json({}, { status: 429 }));
    expect((await new SentryClient({ ...options, fetchImpl: limited.fetchImpl }).recentIssues()).detail).toContain('rate limit');

    const downtime = transport(() => Response.json({}, { status: 503 }));
    const down = await new SentryClient({ ...options, fetchImpl: downtime.fetchImpl }).recentIssues();
    expect(down.ok).toBe(false);
    expect(down.detail).toContain('HTTP 503');

    const throwing = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect((await new SentryClient({ ...options, fetchImpl: throwing }).recentIssues()).ok).toBe(false);
  });

  test('an unexpected payload is not treated as evidence', async () => {
    const { fetchImpl } = transport(() => Response.json({ issues: [] }));
    const evidence = await new SentryClient({ ...options, fetchImpl }).recentIssues();
    expect(evidence.ok).toBe(false);
    expect(evidence.issues).toEqual([]);
  });

  test('parses string counts from the live Sentry API and filters by environment', async () => {
    const { fetchImpl, calls } = transport(() => Response.json([{ id: '9', shortId: 'SENTINEL-1', title: 'boom', level: 'error', count: '4' }]));
    const evidence = await new SentryClient({ ...options, environment: 'production', fetchImpl }).recentIssues();
    expect(evidence.issues[0]!.count).toBe(4);
    expect(calls[0]!.url).toContain('environment%3Aproduction');
  });

  test('counts and titles are bounded', async () => {
    const longTitle = 'x'.repeat(500);
    const { fetchImpl } = transport(() => Response.json([{ id: '1', title: longTitle, level: 'error', count: 9 }]));
    const evidence = await new SentryClient({ ...options, fetchImpl }).recentIssues();
    expect(evidence.issues[0]!.title.length).toBeLessThanOrEqual(120);
  });

  test('environment configuration picks up only complete settings', () => {
    expect(sentryFromEnvironment({}).configured()).toBe(false);
    expect(sentryFromEnvironment({ SENTRY_ORG: 'acme' }).configured()).toBe(false);
    expect(sentryFromEnvironment({ SENTRY_ORG: 'acme', SENTRY_PROJECT: 'web', SENTRY_AUTH_TOKEN: 't' }).configured()).toBe(true);
  });
});