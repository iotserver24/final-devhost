import { readFile } from 'node:fs/promises';
import { generateFixInE2B, publishDraftPr, type ProviderConfig, type RemediationRequest } from '@nexathon/remediator';
import { notifyIncident, redact, resolveSmtpConfig, type Incident } from '@nexathon/notifier';
import { githubCredentials } from './github-app';
import { commentOnIssue, openPendingIncidentIssue, updateIncidentIssue } from './github-issue';
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
  settings?: Pick<IncidentStore, 'readSettings'> & Partial<Pick<IncidentStore, 'save'>>;
}

export interface RemediationDependencies {
  generateFix: typeof generateFixInE2B;
  publishPr: typeof publishDraftPr;
  openIssue: typeof openPendingIncidentIssue;
  updateIssue: typeof updateIncidentIssue;
  credentials: typeof githubCredentials;
  commentIssue: typeof commentOnIssue;
}
const defaultDependencies: RemediationDependencies = {
  generateFix: generateFixInE2B, publishPr: publishDraftPr, openIssue: openPendingIncidentIssue,
  updateIssue: updateIncidentIssue, credentials: githubCredentials, commentIssue: commentOnIssue,
};

async function latestCommitSha(repository: string, token: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/HEAD`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'sentinel' },
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { sha?: unknown };
  return typeof body.sha === 'string' && /^[0-9a-f]{40}$/.test(body.sha) ? body.sha : undefined;
}

async function runRemediation(incident: Incident, config: RemediationConfig, hub?: ActivityHub, settings?: Pick<IncidentStore, 'readSettings'> & Partial<Pick<IncidentStore, 'save'>>, dependencies: RemediationDependencies = defaultDependencies): Promise<RemediationOutcome> {
  let credentials: { read?: string; write?: string } = {};
  if (settings) {
    try {
      credentials = await dependencies.credentials(settings);
      if (credentials.write) process.env.GH_TOKEN = credentials.write;
      if (credentials.read) {
        process.env.GITHUB_READ_TOKEN = credentials.read;
        config.provider.githubReadToken = credentials.read;
      }
    } catch (error) {
      return { ok: false, message: 'Remediation stopped safely: GitHub app token was not issued.', evidence: [redact(String(error))] };
    }
  }
  const token = credentials.write ?? process.env.GH_TOKEN;
  if (!token) return { ok: false, message: 'GitHub credentials are required to open an incident issue before diagnosis.' };

  const run = hub?.create({ incidentId: incident.id, source: 'ai' });
  if (run) hub?.markRunning(run.id);
  try {
    const prefix = `https://github.com/${config.repository}/issues/`;
    const previousUrl = [incident.actionUrl, ...incident.events.filter(item => item.type === 'issue_opened').map(item => item.message)]
      .find(value => value?.startsWith(prefix) && /^\d+$/.test(value.slice(prefix.length)));
    const issue = previousUrl
      ? { url: previousUrl, number: Number(previousUrl.slice(prefix.length)) }
      : await dependencies.openIssue(config.repository, token, incident.id);
    if (!previousUrl) {
      incident.actionUrl = issue.url;
      incident.events.push({ at: new Date().toISOString(), type: 'issue_opened', message: issue.url });
      await settings?.save?.(incident);
    }

    if (!incident.commitSha && settings) {
      try {
        const readToken = credentials.read ?? credentials.write;
        if (readToken) incident.commitSha = await latestCommitSha(config.repository, readToken);
      } catch { /* Report the missing revision below. */ }
    }
    if (!incident.commitSha) {
      if (run) hub?.finish(run.id, 'failed', 'The incident has no commit SHA.');
      return { ok: false, message: 'Incident has no commit SHA; remediation was not started.' };
    }

    let reproductionFixture: RemediationRequest['reproductionFixture'];
    if (config.reproductionFixture) {
      try {
        reproductionFixture = { path: config.reproductionFixture.path, content: await readFile(config.reproductionFixture.sourceFile, 'utf8') };
      } catch {
        if (run) hub?.finish(run.id, 'failed', 'The trusted remediation fixture could not be read.');
        return { ok: false, message: 'Trusted remediation fixture could not be read; no PR was created.' };
      }
    }
    const request: RemediationRequest = {
      incidentId: incident.id, repository: config.repository, commitSha: incident.commitSha,
      evidence: incident.evidence.slice(-20).map(line => line.slice(0, 1000)),
      ...(incident.runtimeLogs ? { runtimeLogs: incident.runtimeLogs } : {}),
      setupCommand: config.setupCommand, reproduceCommand: config.reproduceCommand,
      testCommand: config.testCommand, buildCommand: config.buildCommand,
      ...(reproductionFixture ? { reproductionFixture } : {}), issueUrl: issue.url,
    };
    const fix = await dependencies.generateFix(request, config.provider, {
      onEvent: activity => { if (run) hub?.append(run.id, activity); },
      phase: 'diagnose',
    });
    if (fix.ok && 'phase' in fix && fix.phase === 'awaiting_comment') {
      await dependencies.updateIssue(config.repository, token, issue.number, {
        incidentId: incident.id,
        diagnosis: fix.diagnosis,
        question: fix.question,
        testPath: fix.testPath,
      });
      if (run) hub?.finish(run.id, 'completed', `Paused for a comment on issue #${issue.number}.`);
      return {
        ok: true,
        kind: 'waiting',
        actionUrl: issue.url,
        sandboxId: fix.sandboxId,
        issueNumber: issue.number,
        message: `Waiting for a comment on issue #${issue.number} before writing the fix. sandbox=${fix.sandboxId}`,
        evidence: [`Regression test ${fix.testPath} fails on the broken revision.`],
      };
    }
    if (!fix.ok) {
      if (run) hub?.finish(run.id, 'failed', fix.message);
      return {
        ok: false,
        message: `Remediation stopped safely: ${fix.message}`,
        ...(fix.evidence ? { evidence: [redact(fix.evidence)] } : {}),
      };
    }
    if (run) hub?.finish(run.id, 'failed', 'Diagnosis did not pause for the issue comment; no pull request was created.');
    return { ok: false, message: 'Diagnosis did not pause for the issue comment; no pull request was created.' };
  } catch (error) {
    if (run) hub?.finish(run.id, 'failed', 'Remediation failed before a pull request was opened.');
    return { ok: false, message: 'Remediation failed safely; no PR was created.', evidence: [redact(String(error))] };
  }
}

export async function resumeRemediation(
  incident: Incident,
  comment: string,
  sandboxId: string,
  issue: { number?: number; url?: string },
  phase: 'fix' | 'reply',
  config: RemediationConfig,
  hub?: ActivityHub,
  settings?: Pick<IncidentStore, 'readSettings'>,
  dependencies: RemediationDependencies = defaultDependencies,
): Promise<RemediationOutcome> {
  if (phase === 'fix') {
    const expectedIssue = issue.number ? `https://github.com/${config.repository}/issues/${issue.number}` : '';
    const pause = [...incident.events].reverse().find(item => item.type === 'awaiting_comment');
    const pauseIndex = pause ? incident.events.lastIndexOf(pause) : -1;
    const matchedPause = pause?.message.match(/issue #(\d+)\b[\s\S]*?\bsandbox=([A-Za-z0-9_-]+)/);
    const pausedForIssue = matchedPause && Number(matchedPause[1]) === issue.number && matchedPause[2] === sandboxId;
    const resumed = pause && incident.events.slice(pauseIndex + 1).some(item => item.type === 'review_resumed');
    if (!comment.trim() || !expectedIssue || issue.url !== expectedIssue || !pausedForIssue || !resumed) {
      return { ok: false, message: 'A matching incident issue and owner comment are required before creating a fix.' };
    }
  }
  if (settings) {
    try {
      const credentials = await dependencies.credentials(settings);
      if (credentials.write) process.env.GH_TOKEN = credentials.write;
      if (credentials.read) config.provider.githubReadToken = credentials.read;
    } catch (error) {
      return { ok: false, message: 'Remediation stopped safely: GitHub app token was not issued.', evidence: [redact(String(error))] };
    }
  }
  if (!incident.commitSha) return { ok: false, message: 'Incident has no commit SHA; the paused sandbox was not resumed.' };
  const request: RemediationRequest = {
    incidentId: incident.id,
    repository: config.repository,
    commitSha: incident.commitSha,
    evidence: incident.evidence.slice(-20).map(line => line.slice(0, 1000)),
    ...(incident.runtimeLogs ? { runtimeLogs: incident.runtimeLogs } : {}),
    setupCommand: config.setupCommand,
    reproduceCommand: config.reproduceCommand,
    testCommand: config.testCommand,
    buildCommand: config.buildCommand,
    ...(issue.url ? { issueUrl: issue.url } : {}),
  };
  const run = hub?.create({ incidentId: incident.id, source: 'ai' });
  if (run) hub?.markRunning(run.id);
  try {
    const fix = await dependencies.generateFix(request, config.provider, {
      onEvent: activity => { if (run) hub?.append(run.id, activity); },
      phase,
      sandboxId,
      comment,
      ...(issue.url ? { issueUrl: issue.url } : {}),
    });
    if (fix.ok && 'phase' in fix && fix.phase === 'reply') {
      const token = process.env.GH_TOKEN;
      if (token && issue.number) await dependencies.commentIssue(config.repository, token, issue.number, `Incident \`${incident.id}\`\n\n${fix.reply}`).catch(() => undefined);
      if (run) hub?.finish(run.id, 'completed', 'Replied on the incident issue and paused again.');
      return { ok: true, kind: 'reply', sandboxId: fix.sandboxId, issueNumber: issue.number, message: fix.reply };
    }
    if (!fix.ok) {
      if (run) hub?.finish(run.id, 'failed', fix.message);
      return { ok: false, message: `The follow-up stopped before a verified fix. ${fix.message}`, ...(fix.evidence ? { evidence: [redact(fix.evidence)] } : {}) };
    }
    if (!('patch' in fix)) {
      if (run) hub?.finish(run.id, 'failed', 'The follow-up did not produce a verified fix.');
      return { ok: false, message: 'The follow-up stopped before a verified fix.' };
    }
    if (phase !== 'fix') return { ok: false, message: 'Only an approved issue follow-up may create a pull request.' };
    const draftPr = await dependencies.publishPr(request, fix);
    const token = process.env.GH_TOKEN;
    if (token && issue.number) {
      await dependencies.commentIssue(config.repository, token, issue.number, `Incident \`${incident.id}\` is fixed in ${draftPr.url}.`).catch(() => undefined);
    }
    if (run) hub?.finish(run.id, 'completed', `Fix pull request published: ${draftPr.url}`);
    return {
      ok: true,
      kind: 'fix',
      actionUrl: draftPr.url,
      sandboxId: fix.sandboxId,
      issueNumber: issue.number,
      verifiedRegression: fix.verifiedRegression === true,
      message: `Verified patch published as ${draftPr.url}. It references issue #${issue.number ?? 'unknown'}.`,
      evidence: ['The regression test failed before the patch and passed after it.'],
    };
  } catch (error) {
    if (run) hub?.finish(run.id, 'failed', 'The follow-up failed before a verified fix.');
    return { ok: false, message: 'The follow-up failed before a verified fix.', evidence: [redact(String(error))] };
  }
}

export function createControllerActions(config: ControllerActionsConfig, hub?: ActivityHub, dependencies: RemediationDependencies = defaultDependencies): MonitorActions {
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
    ...(config.remediation ? { remediate: incident => runRemediation(incident, config.remediation!, hub, config.settings, dependencies) } : {}),
  };
}
