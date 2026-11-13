import type { Incident, IncidentAction, IncidentEvidenceItem, IncidentService } from '@nexathon/contracts';
import { statusLabels } from '@nexathon/notifier/format';

function formatDuration(from: string, to: string) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Recovery is only "verified" when the incident is recovered, the user journey passed,
 * and no individual service check failed. Anything else must not claim recovery.
 */
export function isVerifiedRecovery(incident: Incident): boolean {
  return incident.status === 'recovered'
    && incident.verification?.journey.result === 'pass'
    && incident.verification.checks.every(check => check.result !== 'fail');
}

/** Recovery durations; null means the value cannot be honestly computed. */
export function recoveryDurations(incident: Incident): { detectionToRecovery: string | null; faultToRecovery: string | null } {
  if (!isVerifiedRecovery(incident)) return { detectionToRecovery: null, faultToRecovery: null };
  const timing = incident.timing;
  const detectedAt = timing?.detectedAt ?? incident.detectedAt;
  const recoveredAt = timing?.verifiedRecoveredAt;
  if (!recoveredAt) return { detectionToRecovery: null, faultToRecovery: null };
  return {
    detectionToRecovery: formatDuration(detectedAt, recoveredAt),
    faultToRecovery: timing?.faultAt ? formatDuration(timing.faultAt, recoveredAt) : null,
  };
}

function formatStamp(value?: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : 'Unknown';
}

/**
 * Recovery metrics. Recovery time is only shown for a verified recovery:
 * the incident must be recovered and the recorded verification must have passed.
 */
export function RecoveryMetrics({ incident }: { incident: Incident }) {
  const verified = isVerifiedRecovery(incident);
  const timing = incident.timing;
  const detectedAt = timing?.detectedAt ?? incident.detectedAt;
  const recoveredAt = verified ? timing?.verifiedRecoveredAt : undefined;
  const { detectionToRecovery, faultToRecovery } = recoveryDurations(incident);
  return <section className="panel metrics-panel" aria-label="Recovery metrics">
    <div className="section-heading">
      <h2>Recovery metrics</h2>
      <span>{verified ? 'verified recovery' : 'not verified'}</span>
    </div>
    {!verified && <p className="metrics-unverified">
      Recovery time is only reported after the action is verified with a service health check and a real user journey.
    </p>}
    <div className="metrics-grid">
      <div>
        <span>Fault occurred</span>
        <strong>{formatStamp(timing?.faultAt)}</strong>
        <em>{timing?.faultAt ? 'recorded by fault injection' : 'not recorded for this incident'}</em>
      </div>
      <div>
        <span>Detected</span>
        <strong>{formatStamp(detectedAt)}</strong>
        <em>first Sentinel observation</em>
      </div>
      <div>
        <span>Verified recovery</span>
        <strong>{formatStamp(recoveredAt)}</strong>
        <em>{verified ? 'journey and health checks passed' : 'pending verification'}</em>
      </div>
      <div>
        <span>Detection → recovery</span>
        <strong>{detectionToRecovery ?? '—'}</strong>
        <em>{detectionToRecovery ? 'measured' : 'needs a verified recovery'}</em>
      </div>
      <div>
        <span>Fault → recovery</span>
        <strong>{faultToRecovery ?? '—'}</strong>
        <em>{timing?.faultAt ? (faultToRecovery ? 'measured' : 'needs a verified recovery') : 'fault time unknown'}</em>
      </div>
    </div>
  </section>;
}

/** Prominent escalation state with the reason and the recommended human next step. */
export function EscalationBanner({ incident }: { incident: Incident }) {
  const escalation = incident.escalation;
  if (!escalation) return null;
  return <section className="escalation-banner" role="alert" aria-label="Needs human attention">
    <div>
      <p className="eyebrow">Needs human attention</p>
      <h2>{escalation.reason}</h2>
      {escalation.recommendedNextStep && <p className="escalation-next-step">Suggested next step: {escalation.recommendedNextStep}</p>}
      <p className="escalation-meta">
        Escalated {formatStamp(escalation.at)}
        {escalation.notificationOutcome ? ` · notification: ${escalation.notificationOutcome}` : ' · no notification attempted'}
      </p>
    </div>
    <span className="escalation-icon" aria-hidden="true">!</span>
  </section>;
}

const healthLabels: Record<IncidentService['health'], string> = {
  healthy: 'Healthy', unhealthy: 'Unhealthy', unknown: 'Unknown',
};

export function AffectedServices({ services }: { services: IncidentService[] }) {
  if (services.length === 0) return null;
  return <section className="panel services-panel" aria-label="Affected services">
    <div className="section-heading"><h2>Affected services</h2><span>{services.length} services</span></div>
    <ul className="services-list">
      {services.map(service => <li key={service.id}>
        <span className={`service-health health-${service.health}`}>{healthLabels[service.health]}</span>
        <div>
          <strong className="mono">{service.id}</strong>
          {service.detail && <p>{service.detail}</p>}
          <span className="service-checked">checked {formatStamp(service.checkedAt)}</span>
        </div>
      </li>)}
    </ul>
  </section>;
}

const confidenceLabels: Record<NonNullable<Incident['cause']>['confidence'], string> = {
  high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence', unknown: 'Cause unknown',
};

/** Symptoms are observed; the cause is the controller's inference and is labelled with its confidence. */
export function Diagnosis({ incident }: { incident: Incident }) {
  const { symptoms, cause } = incident;
  if (!symptoms?.length && !cause) return null;
  return <section className="panel diagnosis-panel" aria-label="Symptoms and likely cause">
    <div className="section-heading"><h2>Symptoms and cause</h2><span>observation vs inference</span></div>
    {symptoms?.length ? <ul className="symptom-list">
      {symptoms.map((symptom, index) => <li key={`${symptom}-${index}`}><span className="symptom-tag">Observed</span>{symptom}</li>)}
    </ul> : null}
    {cause && <div className={`cause-block confidence-${cause.confidence}`}>
      <span className="cause-tag">{confidenceLabels[cause.confidence]}</span>
      <p>{cause.summary}</p>
      {cause.confidence === 'unknown' && <p className="cause-note">The evidence did not support a specific cause. No action was inferred from it.</p>}
    </div>}
  </section>;
}

function policyLabels(action: IncidentAction) {
  if (action.policyResult === 'denied') return 'Denied by policy';
  if (action.policyResult === 'not_evaluated') return 'Policy not evaluated';
  return action.dryRun ? 'Approved (dry run)' : 'Approved';
}

/** Every action request with its policy decision, attempt count, and execution result. */
export function ActionAudit({ actions }: { actions: IncidentAction[] }) {
  if (actions.length === 0) return null;
  return <section className="panel actions-panel" aria-label="Requested actions and policy decisions">
    <div className="section-heading"><h2>Actions and policy</h2><span>{actions.length} request{actions.length === 1 ? '' : 's'}</span></div>
    <ol className="actions-list">
      {actions.map((action, index) => <li key={index} className={`action-row policy-${action.policyResult}`}>
        <div className="action-main">
          <div className="action-title">
            <strong className="mono">{action.kind}</strong>
            <span className="action-target">target <span className="mono">{action.target}</span></span>
            {action.dryRun && <span className="action-flag">Dry run</span>}
            {action.attempt !== undefined && <span className="action-flag">Attempt {action.attempt}</span>}
          </div>
          <p className={`policy-result policy-${action.policyResult}`}>{policyLabels(action)}{action.policyReason ? ` — ${action.policyReason}` : ''}</p>
          {action.result && <p className={`action-result result-${action.result}`}>
            {action.result === 'succeeded' ? 'Executed successfully' : action.result === 'failed' ? 'Execution failed' : 'Not executed'}
            {action.resultReason ? ` — ${action.resultReason}` : ''}
          </p>}
        </div>
        <time>{formatStamp(action.at)}</time>
      </li>)}
    </ol>
  </section>;
}

const checkLabels = { pass: 'Pass', fail: 'Fail', unknown: 'Unknown' } as const;

/** Post-action verification: individual service checks plus the user-facing journey. */
export function Verification({ verification }: { verification?: Incident['verification'] }) {
  if (!verification) return null;
  return <section className="panel verification-panel" aria-label="Verification">
    <div className="section-heading"><h2>Verification</h2><time>{formatStamp(verification.at)}</time></div>
    <ul className="verification-list">
      {verification.checks.map((check, index) => <li key={index} className={`check-${check.result}`}>
        <span className={`check-badge check-${check.result}`}>{checkLabels[check.result]}</span>
        <div>
          <strong>{check.label}</strong>
          {check.serviceId && <span className="mono service-ref"> {check.serviceId}</span>}
          {check.detail && <p>{check.detail}</p>}
        </div>
      </li>)}
      <li className={`check-${verification.journey.result} journey-check`}>
        <span className={`check-badge check-${verification.journey.result}`}>{checkLabels[verification.journey.result]}</span>
        <div>
          <strong>{verification.journey.label}</strong>
          {verification.journey.detail && <p>{verification.journey.detail}</p>}
        </div>
      </li>
    </ul>
  </section>;
}

/** Structured evidence with the observation/inference distinction. Falls back to plain evidence strings. */
export function EvidenceItems({ items, fallback }: { items: IncidentEvidenceItem[]; fallback: string[] }) {
  if (items.length === 0) return null;
  return <section className="panel evidence-panel">
    <div className="section-heading"><h2>Evidence</h2><span>{items.length} entries</span></div>
    <ul className="evidence-items">
      {items.map((item, index) => <li key={index} className={`evidence-${item.kind}`}>
        <div className="evidence-head">
          <span className="evidence-kind">{item.kind === 'observation' ? 'Observation' : 'Inference'}</span>
          <span className="mono">{item.source}</span>
          {item.serviceId && <span className="mono">{item.serviceId}</span>}
          {item.at && <time dateTime={item.at}>{formatStamp(item.at)}</time>}
        </div>
        <p>{item.observation}</p>
      </li>)}
    </ul>
    {fallback.length > 0 && <details className="evidence-extra">
      <summary>Additional recorded evidence ({fallback.length})</summary>
      <ul>{fallback.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    </details>}
  </section>;
}

export function incidentHeadline(incident: Incident) {
  if (incident.cause && incident.cause.confidence !== 'unknown') return incident.cause.summary;
  if (incident.symptoms?.length) return incident.symptoms[0];
  return statusLabels[incident.status];
}
