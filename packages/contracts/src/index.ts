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
