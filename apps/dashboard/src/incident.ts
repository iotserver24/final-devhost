import type { Incident } from '@nexathon/contracts';
import { redact } from '@nexathon/notifier/format';
export type { Incident } from '@nexathon/contracts';

const kinds = ['runtime_regression', 'persistent_defect', 'build_failure', 'config_drift', 'dependency_failure', 'resource_exhaustion'];
const statuses = ['detected', 'investigating', 'rolling_back', 'remediating', 'verifying', 'recovered', 'pr_opened', 'needs_human', 'remediation_failed'];
const decisions = ['rollback', 'fix_pr', 'escalate', 'restore_revision', 'restore_config', 'restart_service'];
const optional = ['deploymentId', 'deploymentUrl', 'commitSha', 'previousDeploymentUrl', 'probePath', 'actionUrl'] as const;
const classifications = ['healthy', 'ignored', 'warning', 'incident', 'unknown'] as const;
const checkResults = ['pass', 'fail', 'unknown'] as const;
const policyResults = ['allowed', 'denied', 'dry_run'] as const;
const actionKinds = ['restore_revision', 'restore_config', 'restart_service', 'rollback', 'fix_pr'] as const;
const actionResults = ['succeeded', 'failed', 'not_executed'] as const;
const notificationOutcomes = ['sent', 'failed', 'not_attempted'] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid incident response.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new Error('Invalid incident field.');
  return redact(value, max);
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid incident timestamp.');
  }
  return value;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T | undefined, label: string): T {
  if (allowed.includes(value as T)) return value as T;
  if (fallback !== undefined) return fallback;
  throw new Error(`Invalid incident ${label}.`);
}
function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid or oversized incident ${label}.`);
  return value;
}
function stringList(value: unknown, max: number, label: string, itemMax: number): string[] {
  return boundedArray(value, max, label)
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => text(entry, itemMax));
}

export function parseIncident(value: unknown): Incident {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; }
    catch { throw new Error('Invalid incident response.'); }
  }
  const item = record(value);
  if (!kinds.includes(String(item.kind)) || !statuses.includes(String(item.status))
    || (item.decision !== undefined && !decisions.includes(String(item.decision)))) throw new Error('Invalid incident state.');
  if (!Array.isArray(item.evidence) || item.evidence.length > 100 || !Array.isArray(item.events) || item.events.length > 500) {
    throw new Error('Invalid or oversized incident evidence.');
  }
  const incident: Incident = {
    id: text(item.id, 120), kind: item.kind as Incident['kind'], status: item.status as Incident['status'],
    detectedAt: date(item.detectedAt), projectId: text(item.projectId, 120),
    evidence: item.evidence.map(value => text(value, 600)),
    events: item.events.map(value => {
      const event = record(value);
      return { at: date(event.at), type: text(event.type, 120), message: text(event.message, 600) };
    }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  };
  for (const key of optional) if (item[key] !== undefined) incident[key] = text(item[key]);
  if (item.decision !== undefined) incident.decision = item.decision as Incident['decision'];
  if (typeof item.targetId === 'string') incident.targetId = text(item.targetId, 80);
  if (item.classification !== undefined) incident.classification = enumValue(item.classification, classifications, undefined, 'classification');
  if (item.evidenceSources !== undefined) incident.evidenceSources = stringList(item.evidenceSources, 20, 'evidence sources', 40);
  if (item.affectedServices !== undefined) incident.affectedServices = stringList(item.affectedServices, 20, 'affected services', 80);
  if (item.evidenceItems !== undefined) {
    incident.evidenceItems = boundedArray(item.evidenceItems, 100, 'evidence items').map(entry => {
      const evidence = record(entry);
      const parsed = {
        source: text(evidence.source, 120),
        observation: text(evidence.observation, 600),
        at: date(evidence.at),
      } as NonNullable<Incident['evidenceItems']>[number];
      if (typeof evidence.serviceId === 'string') parsed.serviceId = text(evidence.serviceId, 120);
      if (Number.isInteger(evidence.inferenceOf) && (evidence.inferenceOf as number) >= 0) parsed.inferenceOf = evidence.inferenceOf as number;
      return parsed;
    });
  }
  if (item.actions !== undefined) {
    incident.actions = boundedArray(item.actions, 20, 'actions').map(entry => {
      const action = record(entry);
      const parsed = {
        kind: enumValue(action.kind, actionKinds, undefined, 'action kind'),
        target: text(action.target, 200),
        dryRun: action.dryRun === true,
        policyResult: enumValue(action.policyResult, policyResults, undefined, 'policy result'),
        policyReason: text(action.policyReason, 600),
        attempt: Number.isInteger(action.attempt) && (action.attempt as number) >= 1 ? action.attempt as number : 1,
        at: date(action.at),
      } as NonNullable<Incident['actions']>[number];
      if (action.executionResult !== undefined) parsed.executionResult = enumValue(action.executionResult, actionResults, undefined, 'action result');
      return parsed;
    });
  }
  if (item.verification !== undefined) {
    const verification = record(item.verification);
    incident.verification = {
      serviceChecks: boundedArray(verification.serviceChecks, 20, 'verification checks').map(entry => {
        const check = record(entry);
        return {
          serviceId: text(check.serviceId, 80),
          result: enumValue(check.result, checkResults, 'unknown', 'verification result'),
          at: date(check.at),
        };
      }),
      journeyCheck: record(verification.journeyCheck).result !== undefined || record(verification.journeyCheck).at !== undefined
        ? (() => {
            const journey = record(verification.journeyCheck);
            const parsed = {
              result: enumValue(journey.result, checkResults, 'unknown', 'journey result'),
              at: date(journey.at ?? verification.checkedAt ?? incident.detectedAt),
            } as NonNullable<Incident['verification']>['journeyCheck'];
            if (typeof journey.detail === 'string') parsed.detail = text(journey.detail, 600);
            return parsed;
          })()
        : { result: 'unknown' as const, at: date(verification.checkedAt ?? incident.detectedAt) },
      passed: verification.passed === true,
    };
  }
  if (item.escalation !== undefined) {
    const escalation = record(item.escalation);
    const parsed = {
      reason: text(escalation.reason, 600),
      at: date(escalation.at),
      recommendedNextStep: text(escalation.recommendedNextStep, 600),
    } as NonNullable<Incident['escalation']>;
    if (escalation.notificationOutcome !== undefined) {
      parsed.notificationOutcome = enumValue(escalation.notificationOutcome, notificationOutcomes, undefined, 'notification outcome');
    }
    incident.escalation = parsed;
  }
  if (item.timing !== undefined) {
    const timing = record(item.timing);
    const parsed: NonNullable<Incident['timing']> = {};
    const keys = ['faultInjectedAt', 'decidedAt', 'actionAt', 'verifiedRecoveryAt'] as const;
    for (const key of keys) {
      if (timing[key] !== undefined && timing[key] !== null) parsed[key] = date(timing[key]);
    }
    incident.timing = parsed;
  }
  return incident;
}

export function parseIncidentList(value: unknown): Incident[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; }
    catch { throw new Error('Expected an incident array with at most 500 entries.'); }
  }
  if (!Array.isArray(value) || value.length > 500) throw new Error('Expected an incident array with at most 500 entries.');
  const incidents = value.map(parseIncident);
  if (new Set(incidents.map(item => item.id)).size !== incidents.length) throw new Error('Duplicate incident IDs in response.');
  return incidents.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
}
