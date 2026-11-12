import { describe, expect, it } from 'bun:test';
import { decideIncident, type IncidentAssessment } from '../src/decision';

const baseAssessment: IncidentAssessment = {
  kind: 'runtime_regression',
  projectId: 'sample-project',
  allowlistedProjectIds: new Set(['sample-project']),
  currentDeploymentIsProduction: true,
  currentDeploymentIsRecent: true,
  consecutiveCurrentFailures: 3,
  probePath: '/api/tasks',
  currentProbe: 'fail',
  previousDeploymentId: 'previous-deployment',
  previousProbePath: '/api/tasks',
  previousProbe: 'pass',
  evidenceConsistent: true,
  rollbackAlreadyAttempted: false,
};

describe('decideIncident', () => {
  it('waits for three consecutive failures', () => {
    const result = decideIncident({ ...baseAssessment, consecutiveCurrentFailures: 2 });
    expect(result.action).toBe('monitor');
  });

  it('allows one rollback only for an allowlisted fresh regression', () => {
    expect(decideIncident(baseAssessment).action).toBe('rollback');
    expect(decideIncident({ ...baseAssessment, rollbackAlreadyAttempted: true }).action).toBe('fix_pr');
  });

  it('chooses a repository fix when rollback evidence is insufficient', () => {
    expect(decideIncident({ ...baseAssessment, projectId: 'other-project' }).action).toBe('fix_pr');
    expect(decideIncident({ ...baseAssessment, currentDeploymentIsProduction: false }).action).toBe('fix_pr');
    expect(decideIncident({ ...baseAssessment, previousProbe: 'unknown' }).action).toBe('fix_pr');
    expect(decideIncident({ ...baseAssessment, previousProbe: 'unknown', previousProtected: true }).action).toBe('rollback');
    expect(decideIncident({ ...baseAssessment, previousProbePath: '/api/health' }).action).toBe('fix_pr');
    expect(decideIncident({ ...baseAssessment, evidenceConsistent: false }).action).toBe('fix_pr');
  });

  it('chooses remediation when the predecessor has the same failure', () => {
    expect(decideIncident({ ...baseAssessment, previousProbe: 'fail' }).action).toBe('fix_pr');
  });

  it('never rolls back for a failed build', () => {
    expect(decideIncident({ ...baseAssessment, kind: 'build_failure' }).action).toBe('fix_pr');
  });
});
