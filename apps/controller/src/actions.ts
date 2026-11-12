import { readFile } from 'node:fs/promises';
import { generateFixInE2B, publishDraftPr, type ProviderConfig, type RemediationRequest } from '@nexathon/remediator';
import { notifyIncident, redact, resolveSmtpConfig, type Incident } from '@nexathon/notifier';
import { githubCredentials } from './github-app';
import type { IncidentStore } from './incident-store';
import type { ActivityHub } from './activity';
import type { MonitorActions, RemediationOutcome } from './monitor';

export interface RemediationConfig {
  repository: string;
  setupCommand: string;
  reproduceCommand: string;
  testCommand: string;
  buildCommand: string;
  provider: ProviderConfig;
  reproductionFixture?: { path: string; sourceFile: string };
}

export interface ControllerActionsConfig {
  slackWebhookUrl?: string;
  remediation?: RemediationConfig;
  settings?: Pick<IncidentStore, 'readSettings'>;
}

async function runRemediation(incident: Incident, config: RemediationConfig, hub?: ActivityHub, settings?: Pick<IncidentStore, 'readSettings'>): Promise<RemediationOutcome> {
  if (!incident.commitSha) return { ok: false, message: 'Incident has no commit SHA; remediation was not started.' };

  let reproductionFixture: RemediationRequest['reproductionFixture'];
  if (config.reproductionFixture) {
    try {
      reproductionFixture = {
        path: config.reproductionFixture.path,
        content: await readFile(config.reproductionFixture.sourceFile, 'utf8'),
      };
    } catch {
      return { ok: false, message: 'Trusted remediation fixture could not be read; no PR was created.' };
    }
  }

  if (settings) {
    try {
      const credentials = await githubCredentials(settings);
      if (credentials.write) process.env.GH_TOKEN = credentials.write;
      if (credentials.read) {
        process.env.GITHUB_READ_TOKEN = credentials.read;
        config.provider.githubReadToken = credentials.read;
      }
    } catch (error) {
      return { ok: false, message: 'Remediation stopped safely: GitHub app token was not issued.', evidence: [redact(String(error))] };
    }
  }

  const request: RemediationRequest = {
    incidentId: incident.id,
    repository: config.repository,
    commitSha: incident.commitSha,
    evidence: incident.evidence,
    ...(incident.runtimeLogs ? { runtimeLogs: incident.runtimeLogs } : {}),
    setupCommand: config.setupCommand,
    reproduceCommand: config.reproduceCommand,
    testCommand: config.testCommand,
    buildCommand: config.buildCommand,
    ...(reproductionFixture ? { reproductionFixture } : {}),
  };

  const run = hub?.create({ incidentId: incident.id, source: 'ai' });
  if (run) hub?.markRunning(run.id);
  try {
    const fix = await generateFixInE2B(request, config.provider, {
      onEvent: activity => { if (run) hub?.append(run.id, activity); },
    });
    if (!fix.ok) {
      if (run) hub?.finish(run.id, 'failed', fix.message);
      return {
        ok: false,
        message: `Remediation stopped safely: ${fix.message}`,
        ...(fix.evidence ? { evidence: [redact(fix.evidence)] } : {}),
      };
    }
    const draftPr = await publishDraftPr(request, fix);
    if (run) hub?.finish(run.id, 'completed', `Fix pull request published: ${draftPr.url}`);
    return {
      ok: true,
      actionUrl: draftPr.url,
      message: 'Verified patch published as an open pull request for review.',
      evidence: ['Reproduction failed before patching; targeted tests and build passed afterward.'],
    };
  } catch (error) {
    if (run) hub?.finish(run.id, 'failed', 'Remediation failed before a pull request was opened.');
    return { ok: false, message: 'Remediation failed safely; no PR was created.', evidence: [redact(String(error))] };
  }
}

export function createControllerActions(config: ControllerActionsConfig, hub?: ActivityHub): MonitorActions {
  return {
    notify: async incident => {
      const saved = config.settings ? await config.settings.readSettings() : {};
      const env = { ...process.env };
      if (saved.SMTP_FROM) env.SMTP_FROM = saved.SMTP_FROM;
      if (saved.SMTP_TO) env.SMTP_TO = saved.SMTP_TO;
      let smtp;
      try { smtp = resolveSmtpConfig(env); }
      catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'SMTP configuration is invalid.' };
      }
      const result = await notifyIncident(incident, { webhookUrl: config.slackWebhookUrl, ...(smtp ? { smtp } : {}) });
      const sentByEmail = Boolean(smtp);
      return result.ok
        ? { ok: true, message: sentByEmail ? 'Email notification sent.' : 'Slack notification sent.' }
        : { ok: false, message: result.message };
    },
    ...(config.remediation ? { remediate: incident => runRemediation(incident, config.remediation!, hub, config.settings) } : {}),
  };
}
