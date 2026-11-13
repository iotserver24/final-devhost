import { describe, expect, test } from 'bun:test';
import type { Incident, IncidentAction, IncidentVerification } from '@nexathon/contracts';
import { parseIncident } from '../src/incident';
import { isVerifiedRecovery, recoveryDurations } from '../src/incident-detail';

const base: Incident = {
  id: 'one', kind: 'runtime_regression', status: 'recovered',
  detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  evidence: ['first'], events: [],
};

const passingVerification: IncidentVerification = {
  at: '2026-10-23T12:00:45Z',
  checks: [
    { label: 'Task API health', serviceId: 'task-api', result: 'pass' },
    { label: 'Dependency health', serviceId: 'dependency', result: 'pass' },
  ],
  journey: { label: 'Task summary request', result: 'pass' },
};

const failedVerification: IncidentVerification = {
  at: '2026-10-23T12:34:12Z',
  checks: [
    { label: 'Task API health', serviceId: 'task-api', result: 'fail' },
    { label: 'Dependency health', serviceId: 'dependency', result: 'pass' },
  ],
  journey: { label: 'Task summary request', result: 'fail' },
};

describe('verified recovery metrics', () => {
  test('a recovered incident with passing verification counts as verified', () => {
    expect(isVerifiedRecovery({ ...base, verification: passingVerification })).toBe(true);
  });

  test('recovery times are computed from detection and fault timestamps', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: { faultAt: '2026-10-23T11:58:10Z', detectedAt: '2026-10-23T12:00:00Z', verifiedRecoveredAt: '2026-10-23T12:00:45Z' },
    });
    const durations = recoveryDurations(incident);
    expect(durations.detectionToRecovery).toBe('45s');
    expect(durations.faultToRecovery).toBe('2m 35s');
  });

  test('a recovered incident without verification data is not verified', () => {
    expect(isVerifiedRecovery(base)).toBe(false);
    expect(recoveryDurations(base)).toEqual({ detectionToRecovery: null, faultToRecovery: null });
  });

  test('failed verification blocks recovery even with a recovered status', () => {
    const incident = { ...base, verification: failedVerification };
    expect(isVerifiedRecovery(incident)).toBe(false);
    expect(recoveryDurations(incident).detectionToRecovery).toBeNull();
  });

  test('a passing journey with one failed service check is not verified', () => {
    const mixed: IncidentVerification = {
      ...passingVerification,
      checks: [...passingVerification.checks, { label: 'Frontend health', result: 'fail' }],
    };
    expect(isVerifiedRecovery({ ...base, verification: mixed })).toBe(false);
  });

  test('missing timestamps never produce invented durations', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: { detectedAt: '2026-10-23T12:00:00Z' },
    });
    expect(recoveryDurations(incident)).toEqual({ detectionToRecovery: null, faultToRecovery: null });
  });

  test('fault-to-recovery stays null when the fault time is unknown', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: { detectedAt: '2026-10-23T12:00:00Z', verifiedRecoveredAt: '2026-10-23T12:00:45Z' },
    });
    expect(recoveryDurations(incident).detectionToRecovery).toBe('45s');
    expect(recoveryDurations(incident).faultToRecovery).toBeNull();
  });

  test('an unrecovered status is never verified even with passing checks', () => {
    expect(isVerifiedRecovery({ ...base, status: 'needs_human', verification: passingVerification })).toBe(false);
    expect(isVerifiedRecovery({ ...base, status: 'remediating', verification: passingVerification })).toBe(false);
  });
});

describe('incident response parsing for FE1 fields', () => {
  test('structured evidence distinguishes observations from inferences', () => {
    const parsed = parseIncident({
      ...base,
      evidenceItems: [
        { source: 'probe', observation: 'HTTP 500.', kind: 'observation', at: '2026-10-23T12:00:01Z', serviceId: 'task-api' },
        { source: 'diagnosis', observation: 'Deployment change is the cause.', kind: 'inference' },
      ],
    });
    expect(parsed.evidenceItems?.map(item => item.kind)).toEqual(['observation', 'inference']);
    expect(parsed.evidenceItems?.[0].serviceId).toBe('task-api');
  });

  test('a denied dry-run action keeps its policy reason without an execution result', () => {
    const parsed = parseIncident({
      ...base, status: 'needs_human',
      actions: [{ kind: 'restart_service', target: 'frontend', dryRun: true, policyResult: 'denied', policyReason: 'Target not allowlisted.' }],
    });
    const action = parsed.actions?.[0] as IncidentAction;
    expect(action.policyResult).toBe('denied');
    expect(action.dryRun).toBe(true);
    expect(action.policyReason).toBe('Target not allowlisted.');
    expect(action.result).toBeUndefined();
  });

  test('an executed action records its attempt and result', () => {
    const parsed = parseIncident({
      ...base,
      actions: [{ kind: 'restore_revision', target: 'task-api', dryRun: false, policyResult: 'approved', attempt: 1, result: 'succeeded' }],
    });
    expect(parsed.actions?.[0].attempt).toBe(1);
    expect(parsed.actions?.[0].result).toBe('succeeded');
  });

  test('an unknown cause confidence is preserved, not coerced', () => {
    const parsed = parseIncident({
      ...base, status: 'needs_human',
      cause: { summary: 'Conflicting signals.', confidence: 'unknown' },
    });
    expect(parsed.cause?.confidence).toBe('unknown');
  });

  test('services carry their health state and check time', () => {
    const parsed = parseIncident({
      ...base,
      services: [
        { id: 'task-api', health: 'unhealthy', checkedAt: '2026-10-23T12:40:02Z' },
        { id: 'dependency', health: 'unknown' },
      ],
    });
    expect(parsed.services?.map(service => service.health)).toEqual(['unhealthy', 'unknown']);
  });

  test('escalation keeps its reason, next step, and notification outcome', () => {
    const parsed = parseIncident({
      ...base, status: 'needs_human',
      escalation: { reason: 'Verification failed.', at: '2026-10-23T12:34:30Z', recommendedNextStep: 'Inspect the config.', notificationOutcome: 'Slack delivered' },
    });
    expect(parsed.escalation?.reason).toBe('Verification failed.');
    expect(parsed.escalation?.recommendedNextStep).toBe('Inspect the config.');
  });

  test('invalid policy results, health states, and evidence kinds are rejected', () => {
    expect(() => parseIncident({ ...base, actions: [{ kind: 'restart', target: 'x', dryRun: true, policyResult: 'maybe' }] })).toThrow('Invalid incident policy result.');
    expect(() => parseIncident({ ...base, services: [{ id: 'x', health: 'broken' }] })).toThrow('Invalid incident service health.');
    expect(() => parseIncident({ ...base, evidenceItems: [{ source: 'probe', observation: 'x', kind: 'guess' }] })).toThrow('Invalid incident evidence kind.');
    expect(() => parseIncident({ ...base, actions: [{ kind: 'restart', target: 'x', dryRun: 'yes', policyResult: 'approved' }] })).toThrow('Invalid incident action dry-run flag.');
  });

  test('timestamps in timing are validated and optional ones may be absent', () => {
    const parsed = parseIncident({ ...base, timing: { detectedAt: '2026-10-23T12:00:00Z', decidedAt: '2026-10-23T12:00:12Z' } });
    expect(parsed.timing?.decidedAt).toBe('2026-10-23T12:00:12Z');
    expect(parsed.timing?.faultAt).toBeUndefined();
    expect(() => parseIncident({ ...base, timing: { detectedAt: '2026-10-23T12:00:00Z', actionAt: 'not-a-date' } })).toThrow('Invalid incident timestamp.');
  });

  test('redaction applies to new text fields', () => {
    const parsed = parseIncident({
      ...base,
      cause: { summary: 'Token leaked: api_key=abc123 in logs.', confidence: 'low' },
    });
    expect(parsed.cause?.summary).toContain('[REDACTED]');
    expect(parsed.cause?.summary).not.toContain('abc123');
  });
});
