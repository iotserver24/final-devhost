import { createHash } from 'node:crypto';
import type { Incident } from '@nexathon/contracts';
import { redact, redactFull, safeLink } from '@nexathon/notifier/format';
import { decideIncident, type ProbeResult } from './decision';
import type { IncidentStore } from './incident-store';

export interface Deployment {
  id: string;
  immutableUrl: string;
  createdAt: string;
  commitSha?: string;
}

export interface ProbeResponse {
  result: 'pass' | 'fail' | 'unknown';
  evidence: string;
  statusCode?: number;
}

export interface RuntimeLog {
  id: string;
  level: string;
  message: string;
  statusCode?: number;
  timestamp: number;
  isError: boolean;
}

export type LogSource = 'runtime-logs' | 'deployment-events';

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix milliseconds when the current rate-limit window resets. */
  reset: number | null;
}

export interface DeploymentSummary {
  id: string;
  state: DeploymentState;
  createdAt: string;
}

export type DeploymentState = 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'UNKNOWN';

export interface DeploymentStatus {
  id: string;
  state: DeploymentState;
  createdAt: string;
  immutableUrl?: string;
  commitSha?: string;
}

export interface DeploymentProvider {
  getProductionDeployment(projectId: string): Promise<Deployment | null>;
  getLatestDeploymentStatus?(projectId: string): Promise<DeploymentStatus | null>;
  getPreviousDeployment(projectId: string, deploymentId: string): Promise<Deployment | null>;
  probeImmutableDeployment(deploymentUrl: string, probePath: string): Promise<ProbeResponse>;
  rollbackProductionTo(projectId: string, deploymentId: string): Promise<{ actionUrl?: string }>;
  probeProduction(projectId: string, probePath: string): Promise<ProbeResponse>;
  /** Short, redacted-at-the-boundary diagnostic lines for an incident deployment. */
  getDeploymentLogs?(projectId: string, deploymentId: string): Promise<string[]>;
  /** Production deployments created after a unix-ms timestamp, for scheduled log pulls. */
  listDeploymentsSince?(projectId: string, sinceMs: number): Promise<DeploymentSummary[]>;
  /** Build/deployment event log of one deployment, pulled once per deployment. */
  getDeploymentEvents?(projectId: string, deploymentId: string): Promise<RuntimeLog[]>;
  /** Request logs for the deployment that is currently serving production. */
  getRuntimeLogs?(projectId: string, deploymentId: string): Promise<RuntimeLog[]>;
  /** Rate-limit telemetry parsed from the provider's most recent API response. */
  getRateLimit?(): RateLimitInfo | null;
  /** Provider-owned host allowlist for deployment URLs returned by its API. */
  isSafeDeploymentUrl?(url: string): boolean;
}

export interface RemediationOutcome {
  ok: boolean;
  actionUrl?: string;
  message: string;
  evidence?: string[];
}

export interface MonitorActions {
  remediate?: (incident: Incident) => Promise<RemediationOutcome>;
  notify?: (incident: Incident) => Promise<{ ok: boolean; message: string }>;
}

export interface MonitorOptions {
  projectId: string;
  allowlistedProjectIds: ReadonlySet<string>;
  probePath: string;
  provider: DeploymentProvider;
  store: Pick<IncidentStore, 'recordProbe' | 'get' | 'save' | 'claimRollback'>;
  recencyWindowMs?: number;
  recoveryAttempts?: number;
  recoveryDelayMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
  actions?: MonitorActions;
  /** Same error repeated within one fetched batch, independent of the HTTP streak. */
  logSignal?: { evidence: string; occurrences: number; logs: RuntimeLog[]; deploymentId: string };
}

export type MonitorResult =
  | { action: 'monitor'; consecutiveFailures: number; reason: string; probe?: ProbeResponse }
  | { action: 'incident'; incident: Incident; duplicate?: boolean; updated?: boolean; probe?: ProbeResponse }
  | { action: 'unavailable'; reason: string; probe?: ProbeResponse };

const defaultWait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const maxEvidenceLength = 600;

function safeProbePath(path: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_-]*$/.test(path) && !path.includes('..');
}

function safeImmutableUrl(value: string, provider?: DeploymentProvider): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const privateIpv4 = /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    if (url.protocol !== 'https:' || !host || host === 'localhost' || host === '::1' || privateIpv4
      || url.username || url.password || url.search || url.hash) return undefined;
    if (provider?.isSafeDeploymentUrl ? !provider.isSafeDeploymentUrl(url.href) : !host.endsWith('.vercel.app')) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

async function appendDeploymentLogs(incident: Incident, options: MonitorOptions, deploymentId: string): Promise<void> {
  if (!options.provider.getDeploymentLogs) return;
  try {
    const lines = await options.provider.getDeploymentLogs(options.projectId, deploymentId);
    const safeLines = lines
      .map(line => evidence(line.replace(/\s+/g, ' ').trim()))
      .filter(Boolean)
      .slice(0, 8);
    if (safeLines.length) incident.evidence.push(...safeLines.map(line => `Deployment log: ${line}`));
  } catch {
    incident.evidence.push('Deployment logs could not be retrieved; incident handling continued safely.');
  }
}

function evidence(value: string): string {
  return redact(value, maxEvidenceLength);
}

function incidentId(projectId: string, deploymentId: string, probePath: string): string {
  const fingerprint = createHash('sha256').update(`${projectId}\0${deploymentId}\0${probePath}`).digest('hex').slice(0, 24);
  return `inc-${fingerprint}`;
}

function event(at: string, type: string, message: string) {
  return { at, type, message: evidence(message) };
}

async function saveAndNotify(
  incident: Incident,
  options: MonitorOptions,
): Promise<void> {
  await options.store.save(incident);
  if (!options.actions?.notify) return;
  try {
    const result = await options.actions.notify(incident);
    incident.events.push(event(new Date().toISOString(), result.ok ? 'notification' : 'notification_failed', result.message));
    if (!result.ok) incident.evidence.push(evidence(`Notification failed: ${result.message}`));
  } catch {
    incident.events.push(event(new Date().toISOString(), 'notification_failed', 'Notification failed unexpectedly; incident action was not retried.'));
    incident.evidence.push('Notification failed unexpectedly; the incident remains available locally.');
  }
  await options.store.save(incident);
}

async function finishRemediation(
  incident: Incident,
  options: MonitorOptions,
): Promise<void> {
  const remediate = options.actions?.remediate;
  if (!remediate) {
    incident.status = 'remediation_failed';
    incident.decision = 'fix_pr';
    incident.evidence.push('No remediation dispatcher is configured; no PR was created.');
    incident.events.push(event(new Date().toISOString(), 'remediation_failed', 'Remediation is not configured. Configure the model, sandbox, and repository connection to enable automatic fixes.'));
    await saveAndNotify(incident, options);
    return;
  }

  incident.status = 'remediating';
  incident.decision = 'fix_pr';
  incident.events.push(event(new Date().toISOString(), 'remediation_started', 'Dispatching bounded fix-PR remediation.'));
  await options.store.save(incident);
  try {
    const result = await remediate(incident);
    if (result.ok) {
      incident.status = 'pr_opened';
      incident.decision = 'fix_pr';
      const actionUrl = safeLink(result.actionUrl);
      if (actionUrl) incident.actionUrl = actionUrl;
      incident.evidence.push(...(result.evidence ?? []).map(evidence));
      incident.events.push(event(new Date().toISOString(), 'draft_pr', result.message));
    } else {
      incident.status = 'remediation_failed';
      incident.decision = 'fix_pr';
      incident.evidence.push(result.message, ...(result.evidence ?? []).map(evidence));
      incident.events.push(event(new Date().toISOString(), 'remediation_failed', result.message));
    }
  } catch {
    incident.status = 'remediation_failed';
    incident.decision = 'fix_pr';
    incident.evidence.push('Remediation failed unexpectedly; no PR was created.');
    incident.events.push(event(new Date().toISOString(), 'remediation_failed', 'The fix attempt failed unexpectedly before a verified PR was created.'));
  }
  await saveAndNotify(incident, options);
}

function makeBuildFailureIncident(
  options: MonitorOptions,
  deployment: DeploymentStatus,
  at: string,
): Incident {
  return {
    id: incidentId(options.projectId, deployment.id, 'build'),
    kind: 'build_failure',
    status: 'detected',
    detectedAt: at,
    projectId: options.projectId,
    deploymentId: deployment.id,
    commitSha: deployment.commitSha,
    deploymentUrl: deployment.immutableUrl ? safeImmutableUrl(deployment.immutableUrl, options.provider) : undefined,
    decision: 'fix_pr',
    evidence: [
      'A production-targeted deployment failed before activation; the current healthy production deployment was not rolled back.',
      `Deployment status: ${deployment.state}.`,
    ].map(evidence),
    events: [
      event(at, 'detected', `Deployment ${deployment.id} reported ${deployment.state} before production activation.`),
      event(at, 'decision', 'Choose the fix-PR path; a failed build must not roll back healthy production.'),
    ],
  };
}

function makeIncident(
  options: MonitorOptions,
  current: Deployment,
  previous: Deployment | null,
  currentEvidence: string,
  previousProbe: ProbeResult,
  previousEvidence: string,
  consecutiveFailures: number,
  firstFailureAt: string,
  currentDeploymentIsProduction: boolean,
  decision: ReturnType<typeof decideIncident>,
  at: string,
): Incident {
  const kind = previousProbe === 'fail' ? 'persistent_defect' : 'runtime_regression';
  const incident: Incident = {
    id: incidentId(options.projectId, current.id, options.probePath),
    kind,
    status: 'detected',
    detectedAt: at,
    projectId: options.projectId,
    deploymentId: current.id,
    commitSha: current.commitSha,
    deploymentUrl: safeImmutableUrl(current.immutableUrl, options.provider),
    previousDeploymentUrl: previous ? safeImmutableUrl(previous.immutableUrl, options.provider) : undefined,
    probePath: options.probePath,
    evidence: [
      options.logSignal
        ? `${consecutiveFailures} occurrences of the same server error in one log pull.`
        : `${consecutiveFailures} consecutive failures observed since ${firstFailureAt}.`,
      `Current deployment probe: ${currentEvidence}`,
      ...(previous ? [`Immediate predecessor probe (${previousProbe}): ${previousEvidence}`] : ['Immediate predecessor is unavailable or could not be verified.']),
      ...(!currentDeploymentIsProduction ? ['The affected deployment is no longer confirmed as production.'] : []),
    ].map(evidence),
    decision: decision.action === 'monitor' ? undefined : decision.action,
    events: [
      event(at, 'detected', options.logSignal
        ? `Incident detected from ${consecutiveFailures} matching errors in one log pull.`
        : `Incident detected after ${consecutiveFailures} consecutive failures of ${options.probePath}.`),
      event(at, 'investigation', `Current and predecessor deployment evidence collected for ${options.probePath}.`),
      event(at, 'decision', decision.reason),
    ],
  };
  return incident;
}

/** Stable identity for repeated occurrences of one server failure. */
export function serverErrorSignature(log: RuntimeLog): string | null {
  const serverError = (log.statusCode !== undefined && log.statusCode >= 500) || log.level === 'error';
  if (!serverError) return null;
  const message = log.message.toLowerCase().replace(/[0-9a-f]{6,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 180);
  return message || null;
}

/** Count one occurrence per unique log ID; an old batch alone cannot trigger again. */
export function runtimeLogSignal(logs: RuntimeLog[], fresh: RuntimeLog[], deploymentId: string): MonitorOptions['logSignal'] {
  const groups = new Map<string, Set<string>>();
  for (const log of logs) {
    const signature = serverErrorSignature(log);
    if (!signature) continue;
    const ids = groups.get(signature) ?? new Set<string>();
    ids.add(log.id);
    groups.set(signature, ids);
  }
  const freshSignatures = new Set(fresh.map(serverErrorSignature).filter(Boolean));
  const match = [...groups].filter(([signature, ids]) => ids.size >= 3 && freshSignatures.has(signature))
    .sort((a, b) => b[1].size - a[1].size)[0];
  if (!match) return undefined;
  return {
    evidence: `Server error repeated ${match[1].size} times in one log pull: ${match[0]}`,
    occurrences: match[1].size, logs, deploymentId,
  };
}

function runtimeLogContext(logs: RuntimeLog[]): string[] {
  return logs.map(log => JSON.stringify({ ...log, message: redactFull(log.message) }));
}

export async function checkProject(options: MonitorOptions): Promise<MonitorResult> {
  const now = options.now ?? (() => new Date());
  const probePath = options.probePath;
  if (!safeProbePath(probePath)) return { action: 'unavailable', reason: 'Probe path must be a local absolute route without query strings.' };

  if (options.provider.getLatestDeploymentStatus) {
    try {
      const latest = await options.provider.getLatestDeploymentStatus(options.projectId);
      if (latest?.state === 'ERROR') {
        const id = incidentId(options.projectId, latest.id, 'build');
        const existing = await options.store.get(id);
        if (existing) return { action: 'incident', incident: existing, duplicate: true };
        const incident = makeBuildFailureIncident(options, latest, now().toISOString());
        await appendDeploymentLogs(incident, options, latest.id);
        options.store.save(incident);
        await finishRemediation(incident, options);
        return { action: 'incident', incident };
      }
    } catch {
      // A deployment-status outage must not suppress the independent runtime probe.
    }
  }

  let current: Deployment | null;
  try {
    current = await options.provider.getProductionDeployment(options.projectId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return { action: 'unavailable', reason: `Could not resolve the current production deployment. ${detail}` };
  }
  if (!current) return { action: 'unavailable', reason: 'No current production deployment is available.' };

  if (options.logSignal && options.logSignal.deploymentId !== current.id) {
    return { action: 'unavailable', reason: 'Production changed after the log batch was fetched; retry with the active deployment.' };
  }

  const currentUrl = safeImmutableUrl(current.immutableUrl, options.provider);
  if (!currentUrl) return { action: 'unavailable', reason: 'Provider returned an invalid immutable deployment URL.' };

  let currentProbe: ProbeResult = 'unknown';
  let currentResponse: ProbeResponse = { result: 'unknown', evidence: 'Probe did not return a result.' };
  let currentEvidence = currentResponse.evidence;
  if (options.logSignal) {
    currentProbe = 'fail';
    currentResponse = { result: 'fail', evidence: options.logSignal.evidence };
    currentEvidence = evidence(options.logSignal.evidence);
  } else {
    try {
      // Judge health on the public production hostname. Immutable *.vercel.app
      // URLs can return 401 from Deployment Protection while the public alias is healthy.
      const result = await options.provider.probeProduction(options.projectId, probePath);
      currentResponse = result;
      currentProbe = result.result;
      currentEvidence = evidence(result.evidence);
    } catch {
      currentEvidence = 'Probe request failed before a response was received.';
    }
  }

  const observedAt = now().toISOString();
  const streakKey = options.logSignal ? 'runtime-log' : probePath;
  const streak = options.logSignal
    ? { consecutiveFailures: options.logSignal.occurrences, firstFailureAt: observedAt }
    : await options.store.recordProbe(options.projectId, current.id, streakKey, currentProbe, observedAt);
  if (currentProbe !== 'fail') {
    return {
      action: 'monitor',
      consecutiveFailures: 0,
      reason: currentProbe === 'pass' ? 'The current deployment probe passed.' : 'Probe result is unknown; the failure streak was reset.',
      probe: currentResponse,
    };
  }
  if (streak.consecutiveFailures < 3 || !streak.firstFailureAt) {
    return {
      action: 'monitor',
      consecutiveFailures: streak.consecutiveFailures,
      reason: options.logSignal
        ? 'Waiting for at least three occurrences of the same server error in one log pull.'
        : 'Waiting for three consecutive failures of the same probe.',
      probe: currentResponse,
    };
  }

  const id = incidentId(options.projectId, current.id, probePath);
  const existing = await options.store.get(id);
  if (existing) {
    let updated = false;
    if (options.logSignal) {
      existing.runtimeLogs = runtimeLogContext(options.logSignal.logs);
      await options.store.save(existing);
      updated = true;
    }
    const lastActivity = Date.parse(existing.events.at(-1)?.at ?? existing.detectedAt);
    const actionStalled = existing.status === 'detected' && existing.decision === 'rollback'
      || existing.status === 'rolling_back' && now().getTime() - lastActivity > 2 * 60_000;
    if (actionStalled) {
      existing.status = 'remediation_failed';
      existing.decision = 'fix_pr';
      existing.evidence.push('A previous controller action did not reach a recorded terminal result; no retry was made.');
      existing.events.push(event(now().toISOString(), 'remediation_failed', 'The previous rollback did not reach a terminal result. Attempting a repository fix without repeating rollback.'));
      await options.store.save(existing);
      updated = true;
    }
    const fixAttempts = existing.events.filter(item => item.type === 'remediation_started').length;
    const fixStoppedEarly = ['needs_human', 'remediation_failed'].includes(existing.status) && fixAttempts < 3
      && !existing.events.some(item => item.type === 'draft_pr');
    if (fixStoppedEarly && options.actions?.remediate) {
      existing.events.push(event(now().toISOString(), 'remediation_retry', 'Retrying the fix. The previous attempt stopped before a pull request.'));
      await options.store.save(existing);
      await finishRemediation(existing, options);
      return { action: 'incident', incident: existing, duplicate: true, updated: true, probe: currentResponse };
    }
    return { action: 'incident', incident: existing, duplicate: true, updated, probe: currentResponse };
  }

  let previous: Deployment | null = null;
  let previousProbe: ProbeResult = 'unknown';
  let previousProtected = false;
  let previousEvidence = 'Predecessor probe was not completed.';
  try {
    previous = await options.provider.getPreviousDeployment(options.projectId, current.id);
    if (previous) {
      const previousUrl = safeImmutableUrl(previous.immutableUrl, options.provider);
      if (previousUrl) {
        const result = await options.provider.probeImmutableDeployment(previousUrl, probePath);
        previousProbe = result.result;
        previousEvidence = evidence(result.evidence);
        previousProtected = result.result === 'unknown' && /HTTP 40[13]/.test(result.evidence);
      } else {
        previousEvidence = 'Provider returned an invalid predecessor deployment URL.';
      }
    } else {
      previousEvidence = 'No trustworthy immediate predecessor was found.';
    }
  } catch {
    previousEvidence = 'Predecessor lookup or probe failed.';
  }

  let currentDeploymentIsProduction = false;
  try {
    const activeDeployment = await options.provider.getProductionDeployment(options.projectId);
    currentDeploymentIsProduction = activeDeployment?.id === current.id;
  } catch {
    currentDeploymentIsProduction = false;
  }

  const firstFailureMs = Date.parse(streak.firstFailureAt);
  const deploymentCreatedMs = Date.parse(current.createdAt);
  const ageMs = now().getTime() - firstFailureMs;
  const deploymentAgeAtFirstFailure = firstFailureMs - deploymentCreatedMs;
  const recencyWindowMs = options.recencyWindowMs ?? 15 * 60_000;
  const decision = decideIncident({
    kind: 'runtime_regression',
    projectId: options.projectId,
    allowlistedProjectIds: options.allowlistedProjectIds,
    currentDeploymentIsProduction,
    currentDeploymentIsRecent: Number.isFinite(firstFailureMs)
      && Number.isFinite(deploymentCreatedMs)
      && ageMs >= 0
      && ageMs <= recencyWindowMs
      && deploymentAgeAtFirstFailure >= 0
      && deploymentAgeAtFirstFailure <= recencyWindowMs,
    consecutiveCurrentFailures: streak.consecutiveFailures,
    probePath,
    currentProbe,
    previousDeploymentId: previous?.id,
    previousProbePath: previous ? probePath : undefined,
    previousProbe,
    previousProtected,
    evidenceConsistent: currentProbe === 'fail',
    rollbackAlreadyAttempted: false,
  });

  let incident = makeIncident(
    options,
    current,
    previous,
    currentEvidence,
    previousProbe,
    previousEvidence,
    streak.consecutiveFailures,
    streak.firstFailureAt,
    currentDeploymentIsProduction,
    decision,
    now().toISOString(),
  );

  if (options.logSignal) {
    incident.runtimeLogs = runtimeLogContext(options.logSignal.logs);
  }
  await appendDeploymentLogs(incident, options, current.id);

  if (decision.action !== 'rollback') {
    await finishRemediation(incident, options);
    return { action: 'incident', incident, probe: currentResponse };
  }

  await options.store.save(incident);
  if (!await options.store.claimRollback(current.id, now().toISOString())) {
    incident.status = 'remediation_failed';
    incident.decision = 'fix_pr';
    incident.evidence.push('A rollback attempt was already recorded for this deployment; no repeat action was made.');
    incident.events.push(event(now().toISOString(), 'rollback_skipped', 'A rollback was already attempted. Continuing with repository investigation and a fix.'));
    await finishRemediation(incident, options);
    return { action: 'incident', incident, probe: currentResponse };
  }

  incident.status = 'rolling_back';
  incident.events.push(event(now().toISOString(), 'rollback_started', 'One guarded rollback attempt was started.'));
  await options.store.save(incident);

  try {
    const rollback = await options.provider.rollbackProductionTo(options.projectId, previous!.id);
    const actionUrl = safeLink(rollback.actionUrl);
    if (actionUrl) incident.actionUrl = actionUrl;
    incident.events.push(event(now().toISOString(), 'rollback_completed', 'Rollback provider accepted the action; recovery is not yet verified.'));
  } catch (error) {
    incident.status = 'remediation_failed';
    incident.decision = 'fix_pr';
    incident.evidence.push(evidence(`Rollback request failed: ${String(error)}`));
    incident.events.push(event(now().toISOString(), 'rollback_failed', 'Rollback failed. Continuing with repository investigation and a fix.'));
    await finishRemediation(incident, options);
    return { action: 'incident', incident, probe: currentResponse };
  }

  const attempts = Math.max(1, Math.min(Math.trunc(options.recoveryAttempts ?? 3), 5));
  const delayMs = Math.max(0, Math.min(options.recoveryDelayMs ?? 2_000, 15_000));
  const wait = options.wait ?? defaultWait;
  let recovered = false;
  let verificationEvidence = 'Production recovery was not verified.';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const verification = await options.provider.probeProduction(options.projectId, probePath);
      verificationEvidence = evidence(verification.evidence);
      if (verification.result === 'pass') {
        recovered = true;
        break;
      }
    } catch {
      verificationEvidence = 'Production recovery probe failed before receiving a response.';
    }
    if (attempt < attempts && delayMs > 0) await wait(delayMs);
  }

  if (recovered) {
    incident.status = 'recovered';
    incident.evidence.push('The failing commit was removed from production by restoring the previous deployment.');
    incident.events.push(event(now().toISOString(), 'verification', `Production recovery verified: ${verificationEvidence}`));
  } else {
    incident.status = 'remediation_failed';
    incident.decision = 'fix_pr';
    incident.evidence.push(evidence(`Rollback recovery verification failed: ${verificationEvidence}`));
    incident.events.push(event(now().toISOString(), 'remediation_failed', 'Production recovery was not verified. Preparing a repository fix without repeating rollback.'));
  }
  if (options.actions?.remediate) {
    await finishRemediation(incident, options);
  } else {
    await saveAndNotify(incident, options);
  }
  return { action: 'incident', incident, probe: currentResponse };
}
