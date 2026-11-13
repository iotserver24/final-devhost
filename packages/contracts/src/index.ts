export const incidentKinds = [
  'runtime_regression',
  'persistent_defect',
  'build_failure',
] as const;

export type IncidentKind = (typeof incidentKinds)[number];

export const incidentStatuses = [
  'detected',
  'investigating',
  'rolling_back',
  'remediating',
  'recovered',
  'pr_opened',
  'needs_human',
  'remediation_failed',
] as const;

export type IncidentStatus = (typeof incidentStatuses)[number];
export type IncidentDecision = 'rollback' | 'fix_pr' | 'escalate';

export interface IncidentEvent {
  at: string;
  type: string;
  message: string;
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
  /** New incident-response fields; optional so older stored incidents stay valid. */
  services?: IncidentService[];
  symptoms?: string[];
  cause?: { summary: string; confidence: 'high' | 'medium' | 'low' | 'unknown' };
  evidenceItems?: IncidentEvidenceItem[];
  actions?: IncidentAction[];
  verification?: IncidentVerification;
  escalation?: IncidentEscalation;
  timing?: IncidentTiming;
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

export type ServiceHealth = 'healthy' | 'unhealthy' | 'unknown';

/** A service affected by an incident, with its last observed health. */
export interface IncidentService {
  id: string;
  health: ServiceHealth;
  checkedAt?: string;
  detail?: string;
}

/** Structured evidence: observations are measured facts, inferences are conclusions drawn from them. */
export interface IncidentEvidenceItem {
  source: string;
  observation: string;
  kind: 'observation' | 'inference';
  at?: string;
  serviceId?: string;
}

export type PolicyResult = 'approved' | 'denied' | 'not_evaluated';
export type ActionResult = 'succeeded' | 'failed' | 'not_executed';

/** One requested action: dry runs carry the policy decision without execution. */
export interface IncidentAction {
  kind: string;
  target: string;
  dryRun: boolean;
  policyResult: PolicyResult;
  policyReason?: string;
  attempt?: number;
  result?: ActionResult;
  resultReason?: string;
  at?: string;
}

export interface IncidentVerificationCheck {
  label: string;
  serviceId?: string;
  result: 'pass' | 'fail' | 'unknown';
  detail?: string;
}

/** Post-action verification: service health plus the user-facing journey. */
export interface IncidentVerification {
  at: string;
  checks: IncidentVerificationCheck[];
  journey: { label: string; result: 'pass' | 'fail' | 'unknown'; detail?: string };
}

/** Why a human is needed and what they should do next. */
export interface IncidentEscalation {
  reason: string;
  at?: string;
  recommendedNextStep?: string;
  notificationOutcome?: string;
}

/** Timestamps for recovery metrics. Unknown times stay undefined; never invent them. */
export interface IncidentTiming {
  faultAt?: string;
  detectedAt: string;
  decidedAt?: string;
  actionAt?: string;
  verifiedRecoveredAt?: string;
  escalatedAt?: string;
}
