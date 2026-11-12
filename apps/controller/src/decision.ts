export type ProbeResult = 'pass' | 'fail' | 'unknown';

export interface IncidentAssessment {
  kind: 'runtime_regression' | 'persistent_defect' | 'build_failure';
  projectId: string;
  allowlistedProjectIds: ReadonlySet<string>;
  currentDeploymentIsProduction: boolean;
  currentDeploymentIsRecent: boolean;
  consecutiveCurrentFailures: number;
  probePath: string;
  currentProbe: ProbeResult;
  previousDeploymentId?: string;
  previousProbePath?: string;
  previousProbe?: ProbeResult;
  /** Immutable deployment URL returned 401/403. That is protection, not an app failure. */
  previousProtected?: boolean;
  evidenceConsistent: boolean;
  rollbackAlreadyAttempted: boolean;
}

export type IncidentAction = 'monitor' | 'rollback' | 'fix_pr';

export interface IncidentDecision {
  action: IncidentAction;
  reason: string;
}

export function decideIncident(assessment: IncidentAssessment): IncidentDecision {
  if (assessment.kind === 'build_failure') {
    return {
      action: 'fix_pr',
      reason: 'Build failures do not change or roll back the active production deployment.',
    };
  }

  if (assessment.consecutiveCurrentFailures < 3) {
    return {
      action: 'monitor',
      reason: 'Require three consecutive failures of the same probe before acting.',
    };
  }

  if (!assessment.evidenceConsistent || assessment.currentProbe !== 'fail') {
    return {
      action: 'fix_pr',
      reason: 'Probe evidence is conflicting or does not confirm a current-deployment failure.',
    };
  }

  if (!assessment.allowlistedProjectIds.has(assessment.projectId)) {
    return {
      action: 'fix_pr',
      reason: 'The project is not on the controller rollback allowlist.',
    };
  }

  if (!assessment.currentDeploymentIsProduction) {
    return {
      action: 'fix_pr',
      reason: 'The affected deployment is not confirmed as the current production deployment.',
    };
  }

  if (!assessment.currentDeploymentIsRecent) {
    return {
      action: 'fix_pr',
      reason: 'The deployment is outside the configured incident recency window.',
    };
  }

  if (!assessment.probePath || assessment.previousProbePath !== assessment.probePath) {
    return {
      action: 'fix_pr',
      reason: 'The current and predecessor must be probed on the same confirmed route.',
    };
  }

  if (!assessment.previousDeploymentId || !assessment.previousProbe
    || (assessment.previousProbe === 'unknown' && !assessment.previousProtected)) {
    return {
      action: 'fix_pr',
      reason: 'A trustworthy predecessor and its same-route probe result are required.',
    };
  }

  if (assessment.previousProbe === 'pass' || assessment.previousProtected) {
    if (assessment.rollbackAlreadyAttempted) {
      return {
        action: 'fix_pr',
        reason: 'A rollback was already attempted for this deployment; no retry is allowed.',
      };
    }

    return {
      action: 'rollback',
      reason: assessment.previousProtected
        ? 'The current production route fails. The previous deployment URL is protected, so production is restored to that deployment before the fix.'
        : 'The current production deployment fails while its predecessor passes.',
    };
  }

  return {
    action: 'fix_pr',
    reason: 'The current and previous deployments fail; rollback is unlikely to resolve the defect.',
  };
}
