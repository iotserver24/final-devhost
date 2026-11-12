import { describe, expect, test } from 'bun:test';
import { classifyProbe, defaultPolicy, isNoise, mayActOn, policyFromEnvironment } from '../src/classify';

describe('HTTP error classification', () => {
  test('2xx and 3xx are healthy', () => {
    expect(classifyProbe({ route: '/api/tasks', statusCode: 200 }).classification).toBe('healthy');
    expect(classifyProbe({ route: '/api/tasks', statusCode: 302 }).classification).toBe('healthy');
  });

  test('a normal 404 on a non-critical route is ignored, not an incident', () => {
    const result = classifyProbe({ route: '/tasks/does-not-exist', statusCode: 404 });
    expect(result.classification).toBe('ignored');
    expect(isNoise(result.classification)).toBe(true);
    expect(mayActOn(result.classification)).toBe(false);
  });

  test('a 404 on a critical route is an incident', () => {
    const viaPolicy = classifyProbe({ route: '/api/health', statusCode: 404 });
    expect(viaPolicy.classification).toBe('incident');
    const viaFlag = classifyProbe({ route: '/custom/route', statusCode: 404, critical: true });
    expect(viaFlag.classification).toBe('incident');
  });

  test('a 404 spike above baseline is an incident even on a non-critical route', () => {
    const result = classifyProbe({ route: '/products/1', statusCode: 404, notFoundCount: 120, baselineNotFound: 10 });
    expect(result.classification).toBe('incident');
    expect(result.reason).toContain('baseline');
  });

  test('a modest 404 count stays ignored', () => {
    const result = classifyProbe({ route: '/products/1', statusCode: 404, notFoundCount: 12, baselineNotFound: 10 });
    expect(result.classification).toBe('ignored');
  });

  test('401/403 are warnings once, incidents when repeated on a critical route', () => {
    expect(classifyProbe({ route: '/api/health', statusCode: 401 }).classification).toBe('warning');
    expect(classifyProbe({ route: '/api/health', statusCode: 403, occurrences: 2 }).classification).toBe('warning');
    expect(classifyProbe({ route: '/api/health', statusCode: 401, occurrences: 3 }).classification).toBe('incident');
    // Non-critical routes stay warnings even when repeated.
    expect(classifyProbe({ route: '/public/feed', statusCode: 403, occurrences: 9 }).classification).toBe('warning');
  });

  test('408 and 429 are transient warnings and escalate only when repeated on a critical route', () => {
    expect(classifyProbe({ route: '/api/health', statusCode: 429 }).classification).toBe('warning');
    expect(classifyProbe({ route: '/api/health', statusCode: 408, occurrences: 3 }).classification).toBe('incident');
    expect(classifyProbe({ route: '/api/report', statusCode: 429, occurrences: 5 }).classification).toBe('warning');
  });

  test('a single 5xx is a warning, repeated 5xx is an incident', () => {
    expect(classifyProbe({ route: '/api/tasks', statusCode: 500 }).classification).toBe('warning');
    expect(classifyProbe({ route: '/api/tasks', statusCode: 500, occurrences: 3 }).classification).toBe('incident');
    expect(classifyProbe({ route: '/api/tasks', statusCode: 503, occurrences: 4 }).classification).toBe('incident');
    // Unlisted 5xx is still treated as a server error.
    expect(classifyProbe({ route: '/api/tasks', statusCode: 599, occurrences: 3 }).classification).toBe('incident');
  });

  test('other 4xx are informational once and warnings when repeated', () => {
    expect(classifyProbe({ route: '/api/tasks', statusCode: 422 }).classification).toBe('ignored');
    expect(classifyProbe({ route: '/api/tasks', statusCode: 422, occurrences: 4 }).classification).toBe('warning');
  });

  test('no response is unknown, never actionable', () => {
    const result = classifyProbe({ route: '/api/tasks' });
    expect(result.classification).toBe('unknown');
    expect(mayActOn(result.classification)).toBe(false);
  });

  test('custom policy is honoured', () => {
    const policy = { ...defaultPolicy, criticalRoutes: ['/healthz'], repeatThreshold: 2 };
    expect(classifyProbe({ route: '/healthz', statusCode: 404 }, policy).classification).toBe('incident');
    expect(classifyProbe({ route: '/api/health', statusCode: 404 }, policy).classification).toBe('ignored');
    expect(classifyProbe({ route: '/api/tasks', statusCode: 500, occurrences: 2 }, policy).classification).toBe('incident');
  });
});

describe('policyFromEnvironment', () => {
  test('returns defaults when nothing is configured', () => {
    const { policy, problem } = policyFromEnvironment({});
    expect(problem).toBeUndefined();
    expect(policy).toEqual(defaultPolicy);
  });

  test('applies valid overrides', () => {
    const { policy, problem } = policyFromEnvironment({
      CONTROLLER_CRITICAL_ROUTES: '/healthz,/api/health',
      CONTROLLER_REPEAT_THRESHOLD: '2',
      CONTROLLER_INCIDENT_STATUSES: '500,502',
    });
    expect(problem).toBeUndefined();
    expect(policy.criticalRoutes).toEqual(['/healthz', '/api/health']);
    expect(policy.repeatThreshold).toBe(2);
    expect(policy.incidentStatuses).toEqual([500, 502]);
  });

  test('reports malformed values and keeps defaults instead of throwing', () => {
    const { policy, problem } = policyFromEnvironment({
      CONTROLLER_INCIDENT_STATUSES: 'abc',
      CONTROLLER_REPEAT_THRESHOLD: '0',
    });
    expect(problem).toContain('CONTROLLER_INCIDENT_STATUSES');
    expect(problem).toContain('CONTROLLER_REPEAT_THRESHOLD');
    expect(policy.incidentStatuses).toEqual(defaultPolicy.incidentStatuses);
    expect(policy.repeatThreshold).toBe(defaultPolicy.repeatThreshold);
  });
});