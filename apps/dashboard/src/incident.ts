import type { Incident } from '@nexathon/contracts';
import { redact } from '@nexathon/notifier/format';
export type { Incident } from '@nexathon/contracts';

const kinds = ['runtime_regression', 'persistent_defect', 'build_failure', 'config_drift', 'dependency_failure', 'resource_exhaustion'];
const statuses = ['detected', 'investigating', 'rolling_back', 'remediating', 'verifying', 'recovered', 'pr_opened', 'needs_human', 'remediation_failed'];
const decisions = ['rollback', 'fix_pr', 'escalate', 'restore_revision', 'restore_config', 'restart_service'];
const optional = ['deploymentId', 'deploymentUrl', 'commitSha', 'previousDeploymentUrl', 'probePath', 'actionUrl'] as const;

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
  if (typeof item.classification === 'string' && ['healthy', 'ignored', 'warning', 'incident', 'unknown'].includes(item.classification)) {
    incident.classification = item.classification as Incident['classification'];
  }
  if (Array.isArray(item.evidenceSources)) {
    incident.evidenceSources = item.evidenceSources
      .filter((source): source is string => typeof source === 'string')
      .slice(0, 20)
      .map(source => text(source, 40));
  }
  if (Array.isArray(item.affectedServices)) {
    incident.affectedServices = item.affectedServices
      .filter((service): service is string => typeof service === 'string')
      .slice(0, 20)
      .map(service => text(service, 80));
  }
  if (item.escalation && typeof item.escalation === 'object' && !Array.isArray(item.escalation)) {
    const escalation = item.escalation as Record<string, unknown>;
    incident.escalation = {
      reason: text(escalation.reason, 600),
      at: date(escalation.at),
      recommendedNextStep: text(escalation.recommendedNextStep, 600),
      ...(typeof escalation.notificationOutcome === 'string' ? { notificationOutcome: escalation.notificationOutcome as 'sent' | 'failed' | 'not_attempted' } : {}),
    };
  }
  if (item.verification && typeof item.verification === 'object' && !Array.isArray(item.verification)) {
    const verification = item.verification as Record<string, unknown>;
    const checks = Array.isArray(verification.serviceChecks) ? verification.serviceChecks : [];
    incident.verification = {
      serviceChecks: checks.flatMap(check => {
        if (!check || typeof check !== 'object') return [];
        const value = check as Record<string, unknown>;
        return [{ serviceId: text(value.serviceId, 80), result: (['pass', 'fail', 'unknown'].includes(String(value.result)) ? value.result : 'unknown') as 'pass' | 'fail' | 'unknown', at: date(value.at) }];
      }),
      journeyCheck: verification.journeyCheck && typeof verification.journeyCheck === 'object'
        ? (() => {
          const journey = verification.journeyCheck as Record<string, unknown>;
          return { result: (['pass', 'fail', 'unknown'].includes(String(journey.result)) ? journey.result : 'unknown') as 'pass' | 'fail' | 'unknown', at: date(journey.at), ...(typeof journey.detail === 'string' ? { detail: text(journey.detail, 600) } : {}) };
        })()
        : { result: 'unknown' as const, at: date(verification.checkedAt ?? incident.detectedAt) },
      passed: verification.passed === true,
    };
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
