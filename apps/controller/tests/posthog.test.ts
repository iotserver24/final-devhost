import { describe, expect, test } from 'bun:test';
import { PostHogClient, posthogFromEnvironment } from '../src/posthog';

const options = { projectId: '731597', token: 'phx-test', host: 'https://posthog.example.test' };

function transport(response: () => Response) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('PostHog evidence', () => {
  test('is not configured without a project and token', async () => {
    expect(posthogFromEnvironment({}).configured()).toBe(false);
    expect((await new PostHogClient({}).recentIssues()).configured).toBe(false);
  });

  test('maps active issues and keeps the token out of the URL', async () => {
    const { fetchImpl, calls } = transport(() => Response.json({
      results: [
        { id: 'abc', name: 'TypeError in checkout', status: 'active', aggregations: { occurrences: 3 } },
        { nonsense: true },
      ],
    }));
    const evidence = await new PostHogClient({ ...options, fetchImpl }).recentIssues();
    expect(evidence.ok).toBe(true);
    expect(evidence.issues).toEqual([{ id: 'abc', title: 'TypeError in checkout', status: 'active', count: 3 }]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer phx-test');
    expect(calls[0]!.url).not.toContain('phx-test');
    expect(calls[0]!.url).toContain('/api/projects/731597/error_tracking/issues/');
  });

  test('rate limits and bad payloads produce no evidence', async () => {
    const limited = transport(() => new Response('', { status: 429 }));
    expect((await new PostHogClient({ ...options, fetchImpl: limited.fetchImpl }).recentIssues()).detail).toContain('rate limit');
    const odd = transport(() => Response.json({ ok: true }));
    expect((await new PostHogClient({ ...options, fetchImpl: odd.fetchImpl }).recentIssues()).ok).toBe(false);
  });
});
