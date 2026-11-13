import type {
  Incident,
  IncidentAction,
  IncidentEvidenceItem,
  IncidentService,
  IncidentVerification,
  ServiceHealth,
} from '@nexathon/contracts';
import { redact } from '@nexathon/notifier/format';
export type { Incident } from '@nexathon/contracts';

const kinds = ['runtime_regression', 'persistent_defect', 'build_failure'];
const statuses = ['detected', 'investigating', 'rolling_back', 'remediating', 'recovered', 'pr_opened', 'needs_human', 'remediation_failed'];
const decisions = ['rollback', 'fix_pr', 'escalate'];
const optional = ['deploymentId', 'deploymentUrl', 'commitSha', 'previousDeploymentUrl', 'probePath', 'actionUrl'] as const;
const healthStates = ['healthy', 'unhealthy', 'unknown'] as const satisfies readonly ServiceHealth[];
const confidences = ['high', 'medium', 'low', 'unknown'] as const;
const policyResults = ['approved', 'denied', 'not_evaluated'] as const;
const actionResults = ['succeeded', 'failed', 'not_executed'] as const;
const checkResults = ['pass', 'fail', 'unknown'] as const;
const evidenceKinds = ['observation', 'inference'] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid incident response.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new Error('Invalid incident field.');
  return redact(value, max);
}
function optionalText(value: unknown, max = 1000): string | undefined {
  return value === undefined || value === null ? undefined : text(value, max);
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid incident timestamp.');
  }
  return value;
}
function optionalDate(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : date(value);
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid incident ${label}.`);
  return value as T;
}function boundedArray(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid or oversized incident ${label}.`);
  return value;
}

function parseService(value: unknown): IncidentService {
  const item = record(value);
  const service: IncidentService = {
    id: text(item.id, 120),
    health: enumValue(item.health, healthStates, 'service health'),
  };
  const checkedAt = optionalDate(item.checkedAt);
  if (checkedAt !== undefined) service.checkedAt = checkedAt;
  const detail = optionalText(item.detail, 600);
  if (detail !== undefined) service.detail = detail;
  return service;
}

function parseEvidenceItem(value: unknown): IncidentEvidenceItem {
  const item = record(value);
  const evidence: IncidentEvidenceItem = {
    source: text(item.source, 120),
    observation: text(item.observation, 600),
    kind: enumValue(item.kind, evidenceKinds, 'evidence kind'),
  };
  const at = optionalDate(item.at);
  if (at !== undefined) evidence.at = at;
  const serviceId = optionalText(item.serviceId, 120);
  if (serviceId !== undefined) evidence.serviceId = serviceId;
  return evidence;
}

function parseAction(value: unknown): IncidentAction {
  const item = record(value);
  if (item.dryRun !== true && item.dryRun !== false) throw new Error('Invalid incident action dry-run flag.');
  const action: IncidentAction = {
    kind: text(item.kind, 120),
    target: text(item.target, 200),
    dryRun: item.dryRun,
    policyResult: enumValue(item.policyResult, policyResults, 'policy result'),
  };
  const policyReason = optionalText(item.policyReason, 600);
  if (policyReason !== undefined) action.policyReason = policyReason;
  if (item.attempt !== undefined) {
    if (!Number.isInteger(item.attempt) || (item.attempt as number) < 1 || (item.attempt as number) > 5) throw new Error('Invalid incident action attempt count.');
    action.attempt = item.attempt as number;
  }
  if (item.result !== undefined) action.result = enumValue(item.result, actionResults, 'action result');
  const resultReason = optionalText(item.resultReason, 600);
  if (resultReason !== undefined) action.resultReason = resultReason;
  const at = optionalDate(item.at);
  if (at !== undefined) action.at = at;
  return action;
}

function parseVerification(value: unknown): IncidentVerification {
  const item = record(value);
  const journey = record(item.journey);
  const verification: IncidentVerification = {
    at: date(item.at),
    checks: boundedArray(item.checks, 20, 'verification checks').map(check => {
      const entry = record(check);
      const parsed = {
        label: text(entry.label, 200),
        result: enumValue(entry.result, checkResults, 'verification result'),
      } as IncidentVerification['checks'][number];
      const serviceId = optionalText(entry.serviceId, 120);
      if (serviceId !== undefined) parsed.serviceId = serviceId;
      const detail = optionalText(entry.detail, 600);
      if (detail !== undefined) parsed.detail = detail;
      return parsed;
    }),
    journey: {
      label: text(journey.label, 200),
      result: enumValue(journey.result, checkResults, 'journey result'),
    },
  };
  const journeyDetail = optionalText(journey.detail, 600);
  if (journeyDetail !== undefined) verification.journey.detail = journeyDetail;
  return verification;
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
  if (item.services !== undefined) incident.services = boundedArray(item.services, 20, 'services').map(parseService);
  if (item.symptoms !== undefined) incident.symptoms = boundedArray(item.symptoms, 20, 'symptoms').map(value => text(value, 600));
  if (item.cause !== undefined) {
    const cause = record(item.cause);
    incident.cause = {
      summary: text(cause.summary, 600),
      confidence: enumValue(cause.confidence, confidences, 'cause confidence'),
    };
  }
  if (item.evidenceItems !== undefined) incident.evidenceItems = boundedArray(item.evidenceItems, 100, 'evidence items').map(parseEvidenceItem);
  if (item.actions !== undefined) incident.actions = boundedArray(item.actions, 20, 'actions').map(parseAction);
  if (item.verification !== undefined) incident.verification = parseVerification(item.verification);
  if (item.escalation !== undefined) {
    const escalation = record(item.escalation);
    const parsed = { reason: text(escalation.reason, 600) } as NonNullable<Incident['escalation']>;
    const at = optionalDate(escalation.at);
    if (at !== undefined) parsed.at = at;
    const nextStep = optionalText(escalation.recommendedNextStep, 600);
    if (nextStep !== undefined) parsed.recommendedNextStep = nextStep;
    const notification = optionalText(escalation.notificationOutcome, 600);
    if (notification !== undefined) parsed.notificationOutcome = notification;
    incident.escalation = parsed;
  }
  if (item.timing !== undefined) {
    const timing = record(item.timing);
    const parsed = { detectedAt: date(timing.detectedAt ?? item.detectedAt) } as NonNullable<Incident['timing']>;
    const keys = ['faultAt', 'decidedAt', 'actionAt', 'verifiedRecoveredAt', 'escalatedAt'] as const;
    for (const key of keys) {
      const at = optionalDate(timing[key]);
      if (at !== undefined) parsed[key] = at;
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
