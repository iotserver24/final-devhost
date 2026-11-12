import { readFile } from 'node:fs/promises';
import type { Incident } from '@nexathon/contracts';
import { generateFixInE2B, type RemediationActivity, type RemediationRequest } from '@nexathon/remediator';
import type { ActivityHub, ActivitySource } from './activity';
import type { RemediationConfig } from './actions';

const REHEARSAL_STEPS: Array<[RemediationActivity['phase'], RemediationActivity['kind'], string]> = [
  ['sandbox', 'stage', 'Rehearsal only: starting an isolated sandbox'],
  ['checkout', 'stage', 'Rehearsal only: checking out the incident revision'],
  ['setup', 'stage', 'Rehearsal only: installing pinned Bun and sample dependencies'],
  ['reproduction', 'stage', 'Rehearsal only: confirming the regression reproduces'],
  ['reproduction', 'status', 'Rehearsal only: baseline failed as expected'],
  ['agent', 'tool', 'Rehearsal only: Running read_file'],
  ['agent', 'tool', 'Rehearsal only: Running search_replace'],
  ['agent', 'status', 'Rehearsal only: agent finished after 2 tool calls'],
  ['verification', 'stage', 'Rehearsal only: re-running the reproduction, tests and build'],
  ['verification', 'status', 'Rehearsal only: reproduction, tests and build passed'],
];

async function requestFor(incident: Incident, config: RemediationConfig): Promise<RemediationRequest> {
  if (!incident.commitSha || !/^[0-9a-f]{40}$/i.test(incident.commitSha)) {
    throw new Error('The incident has no full 40-character commit SHA, so no sandbox can check out its revision.');
  }
  const fixture = config.reproductionFixture
    ? { path: config.reproductionFixture.path, content: await readFile(config.reproductionFixture.sourceFile, 'utf8') }
    : undefined;
  return {
    incidentId: incident.id,
    repository: config.repository,
    commitSha: incident.commitSha,
    evidence: incident.evidence,
    ...(incident.runtimeLogs ? { runtimeLogs: incident.runtimeLogs } : {}),
    setupCommand: config.setupCommand,
    reproduceCommand: config.reproduceCommand,
    testCommand: config.testCommand,
    buildCommand: config.buildCommand,
    ...(fixture ? { reproductionFixture: fixture } : {}),
  };
}

/** Drives a run to completion in the background and reports only bounded, safe progress. */
export function dispatchRun(
  hub: ActivityHub,
  runId: string,
  incident: Incident,
  source: ActivitySource,
  config?: RemediationConfig,
): void {
  void (async () => {
    hub.markRunning(runId);
    try {
      if (source === 'rehearsal') {
        for (const [phase, kind, message] of REHEARSAL_STEPS) {
          await Bun.sleep(400);
          hub.append(runId, { at: new Date().toISOString(), phase, kind, message });
        }
        hub.finish(runId, 'completed', 'Rehearsal complete. No model, sandbox, PR or production action was used.');
        return;
      }
      if (!config) {
        hub.finish(runId, 'failed', 'Remediation is not configured on this controller; enable CONTROLLER_REMEDIATION_ENABLED first.');
        return;
      }
      const result = await generateFixInE2B(await requestFor(incident, config), config.provider, {
        onEvent: (event) => hub.append(runId, event),
      });
      if (result.ok) {
        hub.finish(runId, 'completed', `Verified a patch touching ${result.changedFiles.length} file(s). Publishing a draft PR is a separate human action.`);
      } else {
        hub.finish(runId, 'failed', `Fix attempt stopped: ${result.reason}. No PR or production action occurred.`);
      }
    } catch (error) {
      hub.finish(runId, 'failed', `The run stopped: ${(error as Error).message}`);
    }
  })();
}
