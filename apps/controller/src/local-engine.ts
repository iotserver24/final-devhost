import type {
  ActionRecord,
  BrokerRequest,
  EscalationRecord,
  Incident,
  ServiceStatus,
  VerificationRecord,
} from '@nexathon/contracts';
import { redact } from '@nexathon/notifier/format';
import type { IncidentStore } from './incident-store';
import { ActionBroker, type DemoEnvironment } from './broker';
import { LocalDemoAdapter, serviceName } from './local-adapter';

/**
 * BE2 local incident engine: monitors BE1's TaskFlow services and the
 * end-to-end journey, builds evidence-backed diagnoses for the four demo
 * faults, acts only through the ActionBroker, verifies recovery, and
 * escalates what it cannot safely automate. Fault labels from the injector
 * are deliberately NOT read here — diagnosis uses observed evidence only.
 */

export interface LocalEngineOptions {
  demoBaseUrl: string;
  store: Pick<IncidentStore, 'get' | 'save'>;
  /** Conflicting evidence still starts a sandbox fix. Service restarts stay blocked. */
  remediate?: (incident: Incident) => Promise<{ ok: boolean; message: string; actionUrl?: string; evidence?: string[] }>;
  pollIntervalMs?: number;
  /** Demo profile detects faster than the cloud monitor's three-failure rule. */
  detectionThreshold?: number;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}

export interface LocalEngine {
  pollNow(): Promise<void>;
  stop(): Promise<void>;
  broker: ActionBroker;
  adapter: LocalDemoAdapter;
}

async function dispatchRepositoryFix(incident: Incident, options: LocalEngineOptions, at: string): Promise<void> {
  if (!options.remediate) {
    incident.status = 'needs_human';
    if (incident.escalation) incident.escalation.recommendedNextStep = 'Repository fix is not configured on this controller, so no sandbox was started.';
    await options.store.save(incident);
    return;
  }
  if (incident.events.some(item => item.type === 'remediation_started')) {
    await options.store.save(incident);
    return;
  }
  incident.status = 'remediating';
  incident.decision = 'fix_pr';
  incident.events.push({ at, type: 'remediation_started', message: 'Starting a sandbox to reproduce the failure and open a fix pull request.' });
  await options.store.save(incident);
  try {
    const result = await options.remediate(incident);
    if (result.ok) {
      incident.status = 'pr_opened';
      if (result.actionUrl) incident.actionUrl = result.actionUrl;
      incident.events.push({ at: new Date().toISOString(), type: 'draft_pr', message: result.message });
    } else {
      incident.status = 'remediation_failed';
      incident.events.push({ at: new Date().toISOString(), type: 'remediation_failed', message: result.message });
    }
    if (result.evidence?.length) incident.evidence.push(...result.evidence.map(item => evidenceLine(item)));
  } catch {
    incident.status = 'remediation_failed';
    incident.events.push({ at: new Date().toISOString(), type: 'remediation_failed', message: 'The sandbox fix failed before a pull request was opened.' });
  }
  await options.store.save(incident);
}

const projectId = 'taskflow-demo';
const maxEvidenceItems = 100;
const verificationAttempts = 3;
const verificationDelayMs = 1_500;

interface Diagnosis {
  kind: Incident['kind'];
  affectedServices: string[];
  cause: string;
  uncertainty?: string;
  action?: BrokerRequest;
  /** Conflicting or insufficient evidence must escalate instead of acting. */
  ambiguous?: string;
}

function evidenceLine(value: string): string {
  return redact(value.replace(/\s+/g, ' ').trim(), 600);
}

function diagnose(
  statuses: ServiceStatus[],
  journey: { result: string; detail: string },
  fault: { knownGoodRevision?: string; knownGoodConfig?: Record<string, string> },
): Diagnosis {
  const byId = new Map(statuses.map(status => [status.serviceId as string, status]));
  const down = statuses.filter(status => status.health === 'unhealthy');
  const unknown = statuses.filter(status => status.health === 'unknown');
  const detail = (id: string) => byId.get(id)?.detail ?? 'no detail';

  // Journey passes: nothing to do regardless of individual oddities.
  if (journey.result === 'pass' && down.length === 0) return { kind: 'runtime_regression', affectedServices: [], cause: '' };

  // Ambiguity: conflicting signals (nothing clearly down but journey fails, or mixed unknowns).
  // A configuration signal in the journey or service detail is a recognized fault pattern,
  // so it is diagnosed below instead of being treated as conflicting evidence.
  const configSignal = /config/i.test(journey.detail) || /config/i.test(detail('task-api')) || /config/i.test(detail('dependency'));
  if (down.length === 0 && journey.result !== 'pass' && !configSignal) {
    return {
      kind: 'runtime_regression',
      affectedServices: [],
      cause: '',
      ambiguous: `The user journey ${journey.result === 'fail' ? 'fails' : 'is unverifiable'} while every service reports healthy. Evidence is conflicting; automated action could target the wrong cause.`,
    };
  }
  if (unknown.length >= 2 && down.length === 0 && !configSignal) {
    return {
      kind: 'runtime_regression',
      affectedServices: [],
      cause: '',
      ambiguous: `Multiple services report unknown state (${unknown.map(status => status.serviceId).join(', ')}); the failing component cannot be identified with confidence.`,
    };
  }

  const dependency = byId.get('dependency');
  const taskApi = byId.get('task-api');

  // Failing dependency: dependency unhealthy, or the task API explicitly reporting a dependency error.
  if (dependency?.health === 'unhealthy' || /dependency/i.test(detail('task-api'))) {
    return {
      kind: 'dependency_failure',
      affectedServices: ['dependency', 'task-api'],
      cause: `The dependency service is ${dependency?.health ?? 'unknown'} (${detail('dependency')}); the task API reports: ${detail('task-api')}.`,
      action: { kind: 'restart_service', target: 'dependency' },
    };
  }

  // Task API down: deployment or resource cause. Distinguish via the safe detail string.
  if (taskApi?.health === 'unhealthy') {
    const apiDetail = detail('task-api');
    if (/memory|oom|exhaust|resource/i.test(apiDetail)) {
      return {
        kind: 'resource_exhaustion',
        affectedServices: ['task-api'],
        cause: `The task API is resource-exhausted: ${apiDetail}. No deployment or configuration change is implicated.`,
        action: { kind: 'restart_service', target: 'task-api' },
      };
    }
    if (fault.knownGoodRevision) {
      return {
        kind: 'runtime_regression',
        affectedServices: ['task-api'],
        cause: `The task API fails its health check (${apiDetail}) while the dependency is ${dependency?.health ?? 'unknown'}; a recent deployment change is the likely cause.`,
        action: { kind: 'restore_revision', target: 'task-api', revision: fault.knownGoodRevision },
      };
    }
    return {
      kind: 'runtime_regression',
      affectedServices: ['task-api'],
      cause: '',
      ambiguous: 'The task API is unhealthy but no known-good revision is published; reverting blindly is unsafe.',
    };
  }

  // Config drift: services healthy-ish but journey fails with a configuration signal.
  if (/config/i.test(journey.detail) || /config/i.test(detail('task-api')) || /config/i.test(detail('dependency'))) {
    const key = Object.keys(fault.knownGoodConfig ?? {})[0];
    if (key) {
      return {
        kind: 'config_drift',
        affectedServices: ['task-api'],
        cause: 'A recent configuration change correlates with the failing user journey; a known-good value exists.',
        action: { kind: 'restore_config', target: 'task-api', configKey: key, configValue: fault.knownGoodConfig![key] },
      };
    }
    return {
      kind: 'config_drift',
      affectedServices: ['task-api'],
      cause: '',
      ambiguous: 'A configuration fault is suspected but no known-good value is published; restoring a guess is unsafe.',
    };
  }

  return {
    kind: 'runtime_regression',
    affectedServices: down.map(status => status.serviceId),
    cause: '',
    ambiguous: `Observed failures (${down.map(status => `${status.serviceId}: ${detail(status.serviceId)}`).join('; ')}) do not match a known fault pattern.`,
  };
}

function incidentIdentity(diagnosis: Diagnosis): string {
  const scope = diagnosis.affectedServices.join('+') || 'none';
  return `inc-local-${diagnosis.kind}-${scope}`;
}

async function verify(adapter: LocalDemoAdapter, wait: (ms: number) => Promise<void>, affected: string[]): Promise<VerificationRecord> {
  const record: VerificationRecord = {
    serviceChecks: [],
    journeyCheck: { result: 'unknown', at: new Date().toISOString() },
    passed: false,
  };
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    const statuses = await adapter.serviceStatuses().catch(() => [] as ServiceStatus[]);
    const journey = await adapter.runJourney();
    record.serviceChecks = statuses
      .filter(status => affected.includes(status.serviceId))
      .map(status => ({ serviceId: status.serviceId, result: status.health === 'healthy' ? 'pass' : status.health === 'unhealthy' ? 'fail' : 'unknown', at: new Date().toISOString() }));
    record.journeyCheck = { result: journey.result, at: new Date().toISOString(), detail: journey.detail };
    record.passed = journey.result === 'pass' && record.serviceChecks.every(check => check.result === 'pass') && record.serviceChecks.length > 0;
    if (record.passed) break;
    if (attempt < verificationAttempts) await wait(verificationDelayMs);
  }
  return record;
}

export function startLocalEngine(options: LocalEngineOptions): LocalEngine {
  const adapter = new LocalDemoAdapter({ demoBaseUrl: options.demoBaseUrl });
  const environment: DemoEnvironment = {
    knownGood: async () => {
      const state = await adapter.faultState();
      return {
        revision: state.knownGoodRevision ?? '',
        configValues: new Map(Object.entries(state.knownGoodConfig ?? {})),
      };
    },
    restoreRevision: revision => adapter.restoreRevision(revision),
    restoreConfig: (key, value) => adapter.restoreConfig(key, value),
    restartService: serviceId => adapter.restartService(serviceId),
  };
  const broker = new ActionBroker(environment, options.now);
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const threshold = options.detectionThreshold ?? 1;
  const streaks = new Map<string, number>();

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cycle: Promise<void> | undefined;

  const pollOnce = async (): Promise<void> => {
    const statuses = await adapter.serviceStatuses().catch(() => [] as ServiceStatus[]);
    const journey = await adapter.runJourney();
    const fault: { knownGoodRevision?: string; knownGoodConfig?: Record<string, string>; faultInjectedAt?: string } = await adapter.faultState().catch(() => ({}) as { knownGoodRevision?: string; knownGoodConfig?: Record<string, string>; faultInjectedAt?: string });

    const diagnosis = diagnose(statuses, journey, fault);
    const identity = incidentIdentity(diagnosis);
    const failing = Boolean(diagnosis.ambiguous) || diagnosis.affectedServices.length > 0;
    const streak = failing ? (streaks.get(identity) ?? 0) + 1 : 0;
    streaks.set(identity, streak);

    if (!failing || streak < threshold) return;

    const existing = await options.store.get(identity);
    const incident: Incident = existing ?? {
      id: identity,
      kind: diagnosis.kind,
      status: 'detected',
      detectedAt: now().toISOString(),
      projectId,
      affectedServices: diagnosis.affectedServices,
      evidence: [],
      events: [],
      timing: {},
    };
    const fixAlreadyStarted = existing?.events.some(item => item.type === 'remediation_started' || item.type === 'draft_pr');
    const lastTouch = Date.parse(existing?.timing?.verifiedRecoveryAt ?? existing?.events.at(-1)?.at ?? existing?.detectedAt ?? '');
    const freshFault = Boolean(existing && fault.faultInjectedAt && Date.parse(fault.faultInjectedAt) > lastTouch);
    if (existing && freshFault && (existing.status === 'recovered' || existing.status === 'needs_human' || existing.status === 'remediation_failed')) {
      existing.status = 'detected';
    } else if (existing && (existing.status === 'recovered' || existing.status === 'pr_opened' || (existing.status === 'needs_human' && fixAlreadyStarted))) return;

    // Evidence: observations only from here; the diagnosis string is an inference and marked as one.
    const at = now().toISOString();
    const evidenceItems: NonNullable<Incident['evidenceItems']> = [
      ...statuses.map(status => ({
        source: 'health_probe',
        observation: `${serviceName(status.serviceId)} health: ${status.health}${status.detail ? ` (${status.detail})` : ''}`,
        at,
        serviceId: status.serviceId,
      })),
      { source: 'journey_check', observation: `End-to-end TaskFlow journey: ${journey.result} (${journey.detail})`, at },
      { source: 'diagnosis', observation: diagnosis.cause || diagnosis.ambiguous || 'Cause unknown.', at, inferenceOf: 0 },
    ].slice(0, maxEvidenceItems);
    incident.evidenceItems = evidenceItems;
    incident.evidence = evidenceItems.map(item => evidenceLine(`${item.source}: ${item.observation}`));
    incident.kind = diagnosis.kind;
    incident.affectedServices = diagnosis.affectedServices;
    if (fault.faultInjectedAt) incident.timing = { ...incident.timing, faultInjectedAt: fault.faultInjectedAt };

    if (diagnosis.ambiguous) {
      incident.decision = 'fix_pr';
      incident.escalation = {
        reason: diagnosis.ambiguous,
        at,
        recommendedNextStep: 'Evidence conflicts, so no service was restarted. A sandbox is checking the repository and opening a fix pull request.',
        notificationOutcome: 'not_attempted',
      };
      incident.timing = { ...incident.timing, decidedAt: at };
      incident.events.push({ at, type: 'escalated', message: evidenceLine(diagnosis.ambiguous) });
      await dispatchRepositoryFix(incident, options, at);
      return;
    }

    // Guarded action through the broker: evaluate first, then execute once.
    const request = diagnosis.action!;
    const decision = await broker.evaluate(request, incident.id, false);
    const actionRecord: ActionRecord = {
      kind: request.kind,
      target: request.target,
      dryRun: false,
      policyResult: decision.allowed ? 'allowed' : 'denied',
      policyReason: decision.reason,
      attempt: 1,
      at,
    };
    incident.timing = { ...incident.timing, decidedAt: now().toISOString() };
    incident.events.push({ at: now().toISOString(), type: 'decision', message: evidenceLine(decision.reason) });

    if (!decision.allowed) {
      incident.status = 'needs_human';
      incident.decision = 'escalate';
      actionRecord.executionResult = 'not_executed';
      incident.actions = [...(incident.actions ?? []), actionRecord];
      incident.escalation = {
        reason: `Policy denied the proposed action: ${decision.reason}`,
        at: now().toISOString(),
        recommendedNextStep: 'Review the policy denial; a human decides whether to act outside the allowlist.',
        notificationOutcome: 'not_attempted',
      };
      incident.events.push({ at: now().toISOString(), type: 'escalated', message: evidenceLine(`Action denied: ${decision.reason}`) });
      await dispatchRepositoryFix(incident, options, now().toISOString());
      return;
    }

    incident.status = 'remediating';
    incident.decision = request.kind;
    incident.timing = { ...incident.timing, actionAt: now().toISOString() };
    incident.events.push({ at: now().toISOString(), type: 'action_started', message: evidenceLine(`Executing ${request.kind} on ${request.target}.`) });
    await options.store.save(incident);

    const executed = await broker.execute(request, incident.id);
    actionRecord.executionResult = executed.reason.startsWith('Execution failed') ? 'failed' : 'succeeded';
    incident.actions = [...(incident.actions ?? []), actionRecord];
    if (actionRecord.executionResult === 'failed') {
      incident.status = 'needs_human';
      incident.decision = 'escalate';
      incident.escalation = {
        reason: `Action execution failed: ${executed.reason}`,
        at: now().toISOString(),
        recommendedNextStep: 'Check the demo environment; the automated attempt failed and will not be retried automatically.',
        notificationOutcome: 'not_attempted',
      };
      incident.events.push({ at: now().toISOString(), type: 'escalated', message: evidenceLine(executed.reason) });
      await dispatchRepositoryFix(incident, options, now().toISOString());
      return;
    }

    incident.status = 'verifying';
    await options.store.save(incident);
    const verification = await verify(adapter, wait, diagnosis.affectedServices);
    incident.verification = verification;
    const verifiedAt = now().toISOString();
    if (verification.passed) {
      incident.status = 'recovered';
      incident.timing = { ...incident.timing, verifiedRecoveryAt: verifiedAt };
      incident.events.push({ at: verifiedAt, type: 'verification', message: 'Recovery verified: affected services and the user journey pass.' });
    } else {
      incident.status = 'needs_human';
      incident.decision = 'escalate';
      incident.escalation = {
        reason: 'The action was executed but recovery could not be verified.',
        at: verifiedAt,
        recommendedNextStep: 'Investigate manually; the automated attempt did not restore the user journey.',
        notificationOutcome: 'not_attempted',
      };
      incident.events.push({ at: verifiedAt, type: 'escalated', message: 'Verification failed after the action; escalating to a human.' });
      await dispatchRepositoryFix(incident, options, verifiedAt);
      return;
    }
    await options.store.save(incident);
  };

  const runCycle = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (cycle) return cycle;
    cycle = pollOnce().catch(error => {
      console.error('Local demo monitor cycle failed:', error instanceof Error ? error.message : error);
    }).finally(() => {
      cycle = undefined;
      if (!stopped) timer = setTimeout(() => void runCycle(), Math.max(1_000, options.pollIntervalMs ?? 5_000));
    });
    return cycle;
  };

  const engine: LocalEngine = {
    pollNow: () => runCycle(),
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await cycle;
    },
    broker,
    adapter,
  };
  void runCycle();
  return engine;
}
