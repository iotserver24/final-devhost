import type { Incident } from '@nexathon/contracts';

function formatDuration(from: string, to: string) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatStamp(value?: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)) : 'Unknown';
}

/**
 * Recovery is only "verified" when the incident is recovered and the recorded
 * verification passed (journey and all service checks). Anything else must not
 * claim recovery.
 */
export function isVerifiedRecovery(incident: Incident): boolean {
  return incident.status === 'recovered'
    && incident.verification?.passed === true
    && incident.verification.journeyCheck.result === 'pass'
    && incident.verification.serviceChecks.every(check => check.result !== 'fail');
}

/** Recovery durations; null means the value cannot be honestly computed. */
export function recoveryDurations(incident: Incident): { detectionToRecovery: string | null; faultToRecovery: string | null } {
  if (!isVerifiedRecovery(incident)) return { detectionToRecovery: null, faultToRecovery: null };
  const recoveredAt = incident.timing?.verifiedRecoveryAt;
  if (!recoveredAt) return { detectionToRecovery: null, faultToRecovery: null };
  return {
    detectionToRecovery: formatDuration(incident.detectedAt, recoveredAt),
    faultToRecovery: incident.timing?.faultInjectedAt ? formatDuration(incident.timing.faultInjectedAt, recoveredAt) : null,
  };
}

/** Recovery metrics panel. Recovery time is only shown for a verified recovery. */
export function RecoveryMetrics({ incident }: { incident: Incident }) {
  const verified = isVerifiedRecovery(incident);
  const timing = incident.timing;
  const recoveredAt = verified ? timing?.verifiedRecoveryAt : undefined;
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
        <strong>{formatStamp(timing?.faultInjectedAt)}</strong>
        <em>{timing?.faultInjectedAt ? 'recorded by fault injection' : 'not recorded for this incident'}</em>
      </div>
      <div>
        <span>Detected</span>
        <strong>{formatStamp(incident.detectedAt)}</strong>
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
        <em>{timing?.faultInjectedAt ? (faultToRecovery ? 'measured' : 'needs a verified recovery') : 'fault time unknown'}</em>
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
      <p className="escalation-next-step">Suggested next step: {escalation.recommendedNextStep}</p>
      <p className="escalation-meta">
        Escalated {formatStamp(escalation.at)}
        {escalation.notificationOutcome ? ` · notification: ${escalation.notificationOutcome}` : ' · no notification attempted'}
      </p>
    </div>
    <span className="escalation-icon" aria-hidden="true">!</span>
  </section>;
}

/** Affected services as recorded by the controller, with classification/target context. */
export function AffectedServices({ incident }: { incident: Incident }) {
  const services = incident.affectedServices ?? [];
  if (services.length === 0 && !incident.classification && !incident.targetId) return null;
  return <section className="panel services-panel" aria-label="Affected services and classification">
    <div className="section-heading">
      <h2>Affected services</h2>
      <span>{services.length ? `${services.length} services` : 'none recorded'}</span>
    </div>
    <div className="services-meta">
      {incident.targetId && <span>Target <strong className="mono">{incident.targetId}</strong></span>}
      {incident.classification && <span>Classification <span className={`tag tag-${incident.classification}`}>{incident.classification}</span></span>}
      {incident.evidenceSources?.length ? <span>Evidence sources <strong>{incident.evidenceSources.join(', ')}</strong></span> : null}
    </div>
    {services.length > 0
      ? <ul className="services-list">
          {services.map(id => <li key={id}><span className="service-health health-unhealthy">Down</span><strong className="mono">{id}</strong></li>)}
        </ul>
      : <p className="services-empty">No individual service was flagged as down.</p>}
  </section>;
}

const policyLabels = { allowed: 'Approved', denied: 'Denied by policy', dry_run: 'Dry run — no mutation' } as const;

/** Every action request with its policy decision, attempt count, and execution result. */
export function ActionAudit({ actions }: { actions: Incident['actions'] }) {
  if (!actions?.length) return null;
  return <section className="panel actions-panel" aria-label="Requested actions and policy decisions">
    <div className="section-heading"><h2>Actions and policy</h2><span>{actions.length} request{actions.length === 1 ? '' : 's'}</span></div>
    <ol className="actions-list">
      {actions.map((action, index) => <li key={index} className={`action-row policy-${action.policyResult}`}>
        <div className="action-main">
          <div className="action-title">
            <strong className="mono">{action.kind}</strong>
            <span className="action-target">target <span className="mono">{action.target}</span></span>
            {action.dryRun && <span className="action-flag">Dry run</span>}
            <span className="action-flag">Attempt {action.attempt}</span>
          </div>
          <p className={`policy-result policy-${action.policyResult}`}>
            {policyLabels[action.policyResult]} — {action.policyReason}
          </p>
          {action.executionResult && <p className={`action-result result-${action.executionResult}`}>
            {action.executionResult === 'succeeded' ? 'Executed successfully' : action.executionResult === 'failed' ? 'Execution failed' : 'Not executed'}
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
    <div className="section-heading">
      <h2>Verification</h2>
      <span className={verification.passed ? 'verified-pill pass' : 'verified-pill fail'}>{verification.passed ? 'passed' : 'failed'}</span>
    </div>
    <ul className="verification-list">
      {verification.serviceChecks.map((check, index) => <li key={index} className={`check-${check.result}`}>
        <span className={`check-badge check-${check.result}`}>{checkLabels[check.result]}</span>
        <div>
          <strong>Service health</strong>
          <span className="mono service-ref"> {check.serviceId}</span>
          <time>{formatStamp(check.at)}</time>
        </div>
      </li>)}
      <li className={`check-${verification.journeyCheck.result} journey-check`}>
        <span className={`check-badge check-${verification.journeyCheck.result}`}>{checkLabels[verification.journeyCheck.result]}</span>
        <div>
          <strong>User journey</strong>
          {verification.journeyCheck.detail && <p>{verification.journeyCheck.detail}</p>}
        </div>
      </li>
    </ul>
  </section>;
}

/** Structured evidence; items with inferenceOf are inferences tied to an observation index. */
export function EvidenceItems({ items, fallback }: { items: Incident['evidenceItems']; fallback: string[] }) {
  if (!items?.length) return null;
  return <section className="panel evidence-panel">
    <div className="section-heading"><h2>Evidence</h2><span>{items.length} entries</span></div>
    <ul className="evidence-items">
      {items.map((item, index) => {
        const inference = item.inferenceOf !== undefined;
        return <li key={index} className={inference ? 'evidence-inference' : 'evidence-observation'}>
          <div className="evidence-head">
            <span className="evidence-kind">{inference ? `Inference of #${(item.inferenceOf ?? 0) + 1}` : 'Observation'}</span>
            <span className="mono">{item.source}</span>
            {item.serviceId && <span className="mono">{item.serviceId}</span>}
            <time dateTime={item.at}>{formatStamp(item.at)}</time>
          </div>
          <p>{item.observation}</p>
        </li>;
      })}
    </ul>
    {fallback.length > 0 && <details className="evidence-extra">
      <summary>Additional recorded evidence ({fallback.length})</summary>
      <ul>{fallback.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
    </details>}
  </section>;
}

/** Headline for cards/detail: the controller's inference if present, else the latest event. */
export function incidentHeadline(incident: Incident) {
  const inference = incident.evidenceItems?.find(item => item.inferenceOf !== undefined);
  if (inference) return inference.observation;
  return incident.events.at(-1)?.message ?? incident.evidence[0] ?? 'No evidence recorded.';
}
