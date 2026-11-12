import { describe, expect, test } from 'bun:test';
import { formatIncidentReport, redact, safeLink, type Incident } from '../src/format';

const incident: Incident = {
  id: 'inc-1', kind: 'runtime_regression', status: 'recovered', detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  decision: 'rollback', actionUrl: 'https://github.com/example/repo/pull/1?ref=demo', evidence: ['HTTP 500 from /api/health'],
  events: [{ at: '2026-10-23T12:00:01Z', type: 'verification', message: 'Recovered' }],
};

describe('notifier safety boundaries', () => {
  test('redacts common credentials and bounds output', () => {
    expect(redact('Authorization: Bearer abc123; xoxb-123-secret')).toContain('[REDACTED authorization]');
    expect(redact('x'.repeat(20), 10)).toBe('xxxxxxxxx…');
  });

  test('only accepts credential-free web links', () => {
    expect(safeLink('https://github.com/example/repo/pull/1?ref=demo')).toBe('https://github.com/example/repo/pull/1');
    expect(safeLink('https://github.com/example/repo/pull/1?token=secret')).toBeUndefined();
    expect(safeLink('https://user:password@example.com/action')).toBeUndefined();
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
  });

  test('includes rollback safety caveat and a sanitized action link', () => {
    const report = formatIncidentReport(incident);
    expect(report.text).toContain('automatic production-domain assignment can be disabled');
    expect(report.text).toContain('https://github.com/example/repo/pull/1');
    expect(report.text).not.toContain('?ref=demo');
    expect(report.html).toContain('NEXATHON / INCIDENT BRIEF');
    expect(report.html).toContain('Important notes');
    expect(report.html).toContain('href="https://github.com/example/repo/pull/1"');
    expect(report.html).not.toContain('?ref=demo');
  });

  test('escapes incident values in the HTML alternative', () => {
    const report = formatIncidentReport({ ...incident, id: '<script>alert(1)</script>' });
    expect(report.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(report.html).not.toContain('<script>alert(1)</script>');
  });
});
