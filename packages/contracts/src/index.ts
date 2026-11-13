export const incidentKinds = [
  'runtime_regression',
  'persistent_defect',
  'build_failure',
  'config_drift',
  'dependency_failure',
  'resource_exhaustion',
] as const;

export type IncidentKind = (typeof incidentKinds)[number];

export const incidentStatuses = [
  'detected',
  'investigating',
  'rolling_back',
  'remediating',
  'verifying',
  'recovered',
  'pr_opened',
  'needs_human',
  'remediation_failed',
] as const;

export type IncidentStatus = (typeof incidentStatuses)[number];
export type IncidentDecision = 'rollback' | 'fix_pr' | 'escalate' | 'restore_revision' | 'restore_config' | 'restart_service';

export interface IncidentEvent {
  at: string;
  type: string;
  message: string;
}

export type HealthState = 'healthy' | 'unhealthy' | 'unknown';

/** HTTP error classification recorded on probe-derived incidents. */
export type IncidentClassification = 'healthy' | 'ignored' | 'warning' | 'incident' | 'unknown';

export type DemoServiceId = 'frontend' | 'task-api' | 'dependency';

export interface ServiceStatus {
  serviceId: DemoServiceId;
  health: HealthState;
  checkedAt: string;
  detail?: string;
}

/** One piece of incident evidence. `inferenceOf` indexes into the incident's
 *  evidence array when this item is an inference rather than an observation. */
export interface EvidenceItem {
  source: string;
  observation: string;
  at: string;
  serviceId?: string;
  inferenceOf?: number;
}

export type BrokerActionKind = Extract<IncidentDecision, 'restore_revision' | 'restore_config' | 'restart_service'>;

export interface BrokerRequest {
  kind: BrokerActionKind;
  target: string;
  revision?: string;
  configKey?: string;
  configValue?: string;
}

export interface BrokerDecision {
  allowed: boolean;
  reason: string;
  dryRun: boolean;
}

export interface ActionRecord {
  kind: BrokerActionKind | 'rollback' | 'fix_pr';
  target: string;
  dryRun: boolean;
  policyResult: 'allowed' | 'denied' | 'dry_run';
  policyReason: string;
  attempt: number;
  executionResult?: 'succeeded' | 'failed' | 'not_executed';
  at: string;
}

export interface VerificationRecord {
  serviceChecks: { serviceId: string; result: 'pass' | 'fail' | 'unknown'; at: string }[];
  journeyCheck: { result: 'pass' | 'fail' | 'unknown'; at: string; detail?: string };
  passed: boolean;
}

export interface EscalationRecord {
  reason: string;
  at: string;
  recommendedNextStep: string;
  notificationOutcome?: 'sent' | 'failed' | 'not_attempted';
}

/** Recovery timing. Durations are computed by the API from these fields;
 *  absent fields mean the value is unknown and must never be invented. */
export interface IncidentTiming {
  faultInjectedAt?: string;
  decidedAt?: string;
  actionAt?: string;
  verifiedRecoveryAt?: string;
}

export interface Incident {
  id: string;
  kind: IncidentKind;
  status: IncidentStatus;
  detectedAt: string;
  projectId: string;
  deploymentId?: string;
  deploymentUrl?: string;
  commitSha?: string;
  previousDeploymentUrl?: string;
  probePath?: string;
  evidence: string[];
  /** Full redacted runtime batch captured when this incident was detected. */
  runtimeLogs?: string[];
  decision?: IncidentDecision;
  actionUrl?: string;
  events: IncidentEvent[];
  evidenceItems?: EvidenceItem[];
  actions?: ActionRecord[];
  verification?: VerificationRecord;
  escalation?: EscalationRecord;
  timing?: IncidentTiming;
  affectedServices?: string[];
  /** Probe result classification; absent for non-probe incidents. */
  classification?: IncidentClassification;
  /** Configured target this incident belongs to (multi-target setups). */
  targetId?: string;
  /** Evidence sources contributing to this incident, for example `sentry`. */
  evidenceSources?: string[];
  /** Demo diagnosis label. Absent when the controller has not classified the fault. */
  cause?: 'code_regression' | 'bad_deploy' | 'failing_dependency';
}

export interface RemediationRequest {
  incidentId: string;
  repository: string;
  targetSha: string;
  evidence: string[];
  reproductionCommand: string;
  timeBudgetSeconds: number;
}

export interface RemediationResult {
  reproduced: boolean;
  testsPassed: boolean;
  buildPassed: boolean;
  draftPullRequestUrl?: string;
  failureReason?: string;
}
