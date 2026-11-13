import { describe, expect, test } from 'bun:test';
import type { Incident, VerificationRecord } from '@nexathon/contracts';
import { parseIncident } from '../src/incident';
import { isVerifiedRecovery, recoveryDurations } from '../src/incident-detail';

const base: Incident = {
  id: 'one', kind: 'runtime_regression', status: 'recovered',
  detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo',
  evidence: ['first'], events: [],
};

const passingVerification: VerificationRecord = {
  passed: true,
  serviceChecks: [
    { serviceId: 'task-api', result: 'pass', at: '2026-10-23T12:00:45Z' },
    { serviceId: 'dependency', result: 'pass', at: '2026-10-23T12:00:45Z' },
  ],
  journeyCheck: { result: 'pass', at: '2026-10-23T12:00:45Z' },
};

const failedVerification: VerificationRecord = {
  passed: false,
  serviceChecks: [
    { serviceId: 'task-api', result: 'fail', at: '2026-10-23T12:34:12Z' },
    { serviceId: 'dependency', result: 'pass', at: '2026-10-23T12:34:12Z' },
  ],
  journeyCheck: { result: 'fail', at: '2026-10-23T12:34:12Z', detail: 'HTTP 500; recovery not verified.' },
};

describe('verified recovery metrics', () => {
  test('a recovered incident with passing verification counts as verified', () => {
    expect(isVerifiedRecovery({ ...base, verification: passingVerification })).toBe(true);
  });

  test('recovery times are computed from detection and fault-injection timestamps', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: { faultInjectedAt: '2026-10-23T11:58:10Z', verifiedRecoveryAt: '2026-10-23T12:00:45Z' },
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
    const mixed: VerificationRecord = {
      passed: true,
      serviceChecks: [...passingVerification.serviceChecks, { serviceId: 'frontend', result: 'fail', at: '2026-10-23T12:00:45Z' }],
      journeyCheck: passingVerification.journeyCheck,
    };
    expect(isVerifiedRecovery({ ...base, verification: mixed })).toBe(false);
  });

  test('missing timestamps never produce invented durations', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: {},
    });
    expect(recoveryDurations(incident)).toEqual({ detectionToRecovery: null, faultToRecovery: null });
  });

  test('fault-to-recovery stays null when the fault time is unknown', () => {
    const incident = parseIncident({
      ...base, verification: passingVerification,
      timing: { verifiedRecoveryAt: '2026-10-23T12:00:45Z' },
    });
    expect(recoveryDurations(incident).detectionToRecovery).toBe('45s');
    expect(recoveryDurations(incident).faultToRecovery).toBeNull();
  });

  test('an unrecovered status is never verified even with passing checks', () => {
    expect(isVerifiedRecovery({ ...base, status: 'needs_human', verification: passingVerification })).toBe(false);
    expect(isVerifiedRecovery({ ...base, status: 'verifying', verification: passingVerification })).toBe(false);
  });
});

describe('incident response parsing for canonical contract fields', () => {
  test('structured evidence keeps the inference index instead of a kind flag', () => {
    const parsed = parseIncident({
      ...base,
      evidenceItems: [
        { source: 'probe', observation: 'HTTP 500.', at: '2026-10-23T12:00:01Z', serviceId: 'task-api' },
        { source: 'diagnosis', observation: 'Deployment change is the cause.', at: '2026-10-23T12:00:05Z', inferenceOf: 0 },
      ],
    });
    expect(parsed.evidenceItems?.[1].inferenceOf).toBe(0);
    expect(parsed.evidenceItems?.[0].serviceId).toBe('task-api');
  });

  test('a denied dry-run action keeps its policy reason without an execution result', () => {
    const parsed = parseIncident({
      ...base, status: 'needs_human',
      actions: [{ kind: 'restart_service', target: 'frontend', dryRun: true, policyResult: 'denied', policyReason: 'Target not allowlisted.', attempt: 1, at: '2026-10-23T12:40:13Z' }],
    });
    const action = parsed.actions?.[0];
    expect(action?.policyResult).toBe('denied');
    expect(action?.dryRun).toBe(true);
    expect(action?.policyReason).toBe('Target not allowlisted.');
    expect(action?.executionResult).toBeUndefined();
  });

  test('an executed action records its attempt and result', () => {
    const parsed = parseIncident({
      ...base,
      actions: [{ kind: 'restore_revision', target: 'task-api', dryRun: false, policyResult: 'allowed', policyReason: 'Known-good revision confirmed.', attempt: 1, executionResult: 'succeeded', at: '2026-10-23T12:00:20Z' }],
    });
    expect(parsed.actions?.[0].attempt).toBe(1);
    expect(parsed.actions?.[0].executionResult).toBe('succeeded');
  });

  test('multi-target, classification, and evidence sources are parsed', () => {
    const parsed = parseIncident({
      ...base, targetId: 'local-compose', classification: 'incident', evidenceSources: ['probe', 'sentry'], affectedServices: ['task-api'],
    });
    expect(parsed.targetId).toBe('local-compose');
    expect(parsed.classification).toBe('incident');
    expect(parsed.evidenceSources).toEqual(['probe', 'sentry']);
    expect(parsed.affectedServices).toEqual(['task-api']);
  });

  test('escalation keeps its reason, next step, and notification outcome enum', () => {
    const parsed = parseIncident({
      ...base, status: 'needs_human',
      escalation: { reason: 'Verification failed.', at: '2026-10-23T12:34:30Z', recommendedNextStep: 'Inspect the config.', notificationOutcome: 'failed' },
    });
    expect(parsed.escalation?.reason).toBe('Verification failed.');
    expect(parsed.escalation?.recommendedNextStep).toBe('Inspect the config.');
    expect(parsed.escalation?.notificationOutcome).toBe('failed');
  });

  test('invalid classifications, policy results, and action kinds are rejected', () => {
    expect(() => parseIncident({ ...base, classification: 'critical' })).toThrow('Invalid incident classification.');
    expect(() => parseIncident({ ...base, actions: [{ kind: 'restart_service', target: 'x', dryRun: true, policyResult: 'maybe', policyReason: 'r', attempt: 1, at: '2026-10-23T12:00:00Z' }] })).toThrow('Invalid incident policy result.');
    expect(() => parseIncident({ ...base, actions: [{ kind: 'rm_rf', target: 'x', dryRun: true, policyResult: 'allowed', policyReason: 'r', attempt: 1, at: '2026-10-23T12:00:00Z' }] })).toThrow('Invalid incident action kind.');
    expect(() => parseIncident({ ...base, timing: { actionAt: 'not-a-date' } })).toThrow('Invalid incident timestamp.');
  });

  test('new kinds and statuses from main are accepted; old stored incidents stay valid', () => {
    expect(parseIncident({ ...base, kind: 'config_drift', status: 'verifying' }).kind).toBe('config_drift');
    expect(parseIncident(base).evidenceItems).toBeUndefined();
  });

  test('redaction applies to new text fields', () => {
    const parsed = parseIncident({
      ...base,
      evidenceItems: [{ source: 'logs', observation: 'Token leaked: api_key=abc123 in logs.', at: '2026-10-23T12:00:01Z' }],
    });
    expect(parsed.evidenceItems?.[0].observation).toContain('[REDACTED]');
    expect(parsed.evidenceItems?.[0].observation).not.toContain('abc123');
  });
});
