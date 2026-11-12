import type { Incident } from './incident';

// Rehearsal evidence only: these events are not results of live deployments or PRs.
export const fixtureIncidents: Incident[] = [
  {
    id: 'demo-104', kind: 'persistent_defect', status: 'needs_human',
    detectedAt: '2026-10-23T12:24:00Z', projectId: 'demo-project', deploymentId: 'demo-sandbox-failure',
    probePath: '/api/health', commitSha: '4c1de9a', decision: 'escalate',
    evidence: ['Current and previous deployments fail the same probe.', 'Sandbox time budget exhausted. No passing test proof or PR is available.', 'Slack notification failed in this rehearsal; the report remains available locally.'],
    events: [
      { at: '2026-10-23T12:24:00Z', type: 'detected', message: 'Three consecutive route probes failed.' },
      { at: '2026-10-23T12:24:12Z', type: 'decision', message: 'Previous deployment also failed; rollback would not help.' },
      { at: '2026-10-23T12:26:12Z', type: 'escalation', message: 'Sandbox timed out. Human investigation required; no PR created.' },
      { at: '2026-10-23T12:26:17Z', type: 'notification_failed', message: 'Slack timed out. Incident processing was not blocked.' },
    ],
  },
  {
    id: 'demo-103', kind: 'build_failure', status: 'remediating',
    detectedAt: '2026-10-23T12:16:00Z', projectId: 'demo-project', deploymentId: 'demo-failed-build',
    commitSha: 'ba73e20', decision: 'fix_pr',
    evidence: ['New deployment build failed: TypeScript compilation error.', 'Last healthy production deployment remains active.', 'Fix attempt in progress. No draft PR or passing test evidence yet.'],
    events: [
      { at: '2026-10-23T12:16:00Z', type: 'detected', message: 'Deployment status check reported a failed build.' },
      { at: '2026-10-23T12:16:04Z', type: 'decision', message: 'Do not roll back healthy production. Dispatch the fix-PR path.' },
      { at: '2026-10-23T12:16:10Z', type: 'remediation', message: 'Sandbox is reproducing the build failure.' },
    ],
  },
  {
    id: 'demo-102', kind: 'persistent_defect', status: 'pr_opened',
    detectedAt: '2026-10-23T12:08:00Z', projectId: 'demo-project', deploymentId: 'demo-persistent',
    deploymentUrl: 'https://current-demo.example.com', previousDeploymentUrl: 'https://previous-demo.example.com',
    commitSha: 'cf38ab1', probePath: '/api/health', decision: 'fix_pr',
    actionUrl: 'https://github.com/example/nexathon/pull/42',
    evidence: ['Current immutable deployment: /api/health returned HTTP 500.', 'Immediate predecessor: the same route returned HTTP 500.', 'Reproduction failed before the patch; targeted test and build passed afterward. Fixture proof only.'],
    events: [
      { at: '2026-10-23T12:08:00Z', type: 'detected', message: 'Three consecutive probes failed.' },
      { at: '2026-10-23T12:08:12Z', type: 'decision', message: 'Both revisions fail. Choose a draft fix PR; no rollback.' },
      { at: '2026-10-23T12:08:30Z', type: 'reproduction', message: 'Targeted reproduction failed before patching.' },
      { at: '2026-10-23T12:10:30Z', type: 'test', message: 'Patch produced; targeted test and build passed after patching.' },
      { at: '2026-10-23T12:11:00Z', type: 'pr', message: 'Draft PR opened for human review. Production has not been repaired.' },
      { at: '2026-10-23T12:11:03Z', type: 'notification', message: 'Slack report linked the draft PR in this fixture scenario.' },
    ],
  },
  {
    id: 'demo-101', kind: 'runtime_regression', status: 'recovered',
    detectedAt: '2026-10-23T12:00:00Z', projectId: 'demo-project', deploymentId: 'demo-regression',
    deploymentUrl: 'https://current-demo.example.com', previousDeploymentUrl: 'https://previous-demo.example.com',
    commitSha: '8e94b2c', probePath: '/api/health', decision: 'rollback', actionUrl: 'https://previous-demo.example.com',
    evidence: ['Current deployment: three consecutive HTTP 500 probes on /api/health.', 'Immediate predecessor: the same route returned HTTP 200.', 'One guarded rollback attempted; post-rollback production probe returned HTTP 200. Fixture proof only.'],
    events: [
      { at: '2026-10-23T12:00:00Z', type: 'detected', message: 'Third failed probe recorded. Open one incident for this deployment.' },
      { at: '2026-10-23T12:00:05Z', type: 'investigation', message: 'Current production revision fails; immediate predecessor passes the same route.' },
      { at: '2026-10-23T12:00:10Z', type: 'decision', message: 'Fresh regression on the allowlisted demo project. Choose rollback.' },
      { at: '2026-10-23T12:00:15Z', type: 'rollback', message: 'One rollback attempt. No code merged.' },
      { at: '2026-10-23T12:00:20Z', type: 'verification', message: 'Production recovery probe passed with HTTP 200.' },
      { at: '2026-10-23T12:00:23Z', type: 'notification', message: 'Slack recovery report sent in this fixture scenario.' },
    ],
  },
];
