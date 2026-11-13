import type { BrokerDecision, BrokerRequest } from '@nexathon/contracts';

/**
 * Independent enforcement layer between Sentinel and the demo environment.
 * The controller and agent can only request fixed operations here; the broker
 * decides alone whether a request is allowed. No arbitrary commands, no host
 * Docker socket. Every request — allowed or denied — produces an audit record.
 */

export interface KnownGoodState {
  /** BE1-published known-good revision for the task API. */
  revision: string;
  /** BE1-published known-good values per allowlisted config key. */
  configValues: Map<string, string>;
}

export interface DemoEnvironment {
  /** Known-good state published by BE1; the broker never trusts agent input for this. */
  knownGood(): Promise<KnownGoodState>;
  restoreRevision(revision: string): Promise<void>;
  restoreConfig(key: string, value: string): Promise<void>;
  restartService(serviceId: string): Promise<void>;
}

export interface BrokerAuditEntry {
  at: string;
  request: BrokerRequest;
  dryRun: boolean;
  allowed: boolean;
  reason: string;
}

/** Fixed allowlists: which target each action kind may touch. Resource
 *  exhaustion remediates by restarting the affected task API, so it is
 *  allowlisted for restarts too; the frontend is demo-control territory
 *  and stays off the action list. */
const allowedTargets: Record<BrokerRequest['kind'], ReadonlySet<string>> = {
  restore_revision: new Set(['task-api']),
  restore_config: new Set(['task-api', 'dependency']),
  restart_service: new Set(['dependency', 'task-api']),
};

const maxConfigValueLength = 200;
const maxRevisionLength = 120;

function validateRequest(request: BrokerRequest): string | null {
  const targets = allowedTargets[request.kind];
  if (!targets.has(request.target)) {
    return `Target "${request.target}" is not allowlisted for ${request.kind}.`;
  }
  if (request.kind === 'restore_revision') {
    if (!request.revision || request.revision.length > maxRevisionLength || /[^\w.-]/.test(request.revision)) {
      return 'A revision identifier with safe characters is required.';
    }
  }
  if (request.kind === 'restore_config') {
    if (!request.configKey || request.configKey.length > maxConfigValueLength) return 'A config key is required.';
    if (request.configValue === undefined || request.configValue.length > maxConfigValueLength) return 'A bounded config value is required.';
  }
  return null;
}

export class ActionBroker {
  private readonly audit: BrokerAuditEntry[] = [];
  private readonly attemptedIncidents = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly environment: DemoEnvironment, now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  /** Policy check without mutation. Dry runs do not consume the one attempt. */
  async evaluate(request: BrokerRequest, incidentId: string, dryRun: boolean): Promise<BrokerDecision> {
    const invalid = validateRequest(request);
    if (invalid) return this.record(request, dryRun, false, invalid);

    const knownGood = await this.environment.knownGood();
    if (request.kind === 'restore_revision' && request.revision !== knownGood.revision) {
      return this.record(request, dryRun, false, 'Revision is not the BE1-published known-good revision; reverting to an unverified version is not allowed.');
    }
    if (request.kind === 'restore_config') {
      const good = knownGood.configValues.get(request.configKey!);
      if (good === undefined) return this.record(request, dryRun, false, `No known-good value exists for config key "${request.configKey}".`);
      if (request.configValue !== good) return this.record(request, dryRun, false, 'Only the known-good value may be restored.');
    }
    if (!dryRun && this.attemptedIncidents.has(incidentId)) {
      return this.record(request, dryRun, false, 'One automatic attempt per incident has already been used; a human must take over.');
    }
    return this.record(request, dryRun, true, 'Request matches the allowlist and known-good state.');
  }

  /** Evaluate, and execute when allowed. Returns the audit entry. */
  async execute(request: BrokerRequest, incidentId: string): Promise<BrokerAuditEntry> {
    const decision = await this.evaluate(request, incidentId, false);
    const entry = this.audit[this.audit.length - 1]!;
    if (!decision.allowed) return entry;
    try {
      if (request.kind === 'restore_revision') await this.environment.restoreRevision(request.revision!);
      else if (request.kind === 'restore_config') await this.environment.restoreConfig(request.configKey!, request.configValue!);
      else await this.environment.restartService(request.target);
    } catch (error) {
      entry.reason = `Execution failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      return entry;
    }
    this.attemptedIncidents.add(incidentId);
    return entry;
  }

  /** Dry-run entry point: same policy path, no mutation, attempt not consumed. */
  async dryRun(request: BrokerRequest, incidentId: string): Promise<BrokerDecision> {
    return this.evaluate(request, incidentId, true);
  }

  private record(request: BrokerRequest, dryRun: boolean, allowed: boolean, reason: string): BrokerDecision {
    this.audit.push({ at: this.now().toISOString(), request, dryRun, allowed, reason });
    if (this.audit.length > 200) this.audit.shift();
    return { allowed, reason, dryRun };
  }

  auditTrail(): BrokerAuditEntry[] {
    return [...this.audit];
  }

  /** Test hook: reset the one-attempt ledger. */
  resetAttempts(): void {
    this.attemptedIncidents.clear();
  }
}
