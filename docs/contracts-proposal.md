# Sentinel shared contracts proposal (v1 — for team agreement)

Owner: BE2. Status: **PROPOSED, not implemented.** Plan step 1 requires BE1, BE2, FE1, FE2 to agree on these before implementation. Comment/edits welcome; silence is not agreement.

Design rule: **additive only.** Existing `Incident`, `IncidentKind`, `IncidentStatus`, `IncidentDecision` in `packages/contracts/src/index.ts` keep their current members and meaning (cloud path keeps working). Everything below extends unions or adds new optional fields/types. `apps/dashboard/src/incident.ts` validates kinds/statuses/decisions with hardcoded arrays — extending a union requires updating that parser in the same PR.

## 1. Service identity

Fixed service IDs for the demo target (BE1 to confirm names/ports):

| Service ID | Role |
| --- | --- |
| `frontend` | TaskFlow UI |
| `task-api` | Task API; depends on `dependency` for a real user-facing operation |
| `dependency` | Separate dependency service |

## 2. Service status (new type)

```ts
export type HealthState = 'healthy' | 'unhealthy' | 'unknown';

export interface ServiceStatus {
  serviceId: 'frontend' | 'task-api' | 'dependency';
  health: HealthState;
  checkedAt: string;          // ISO timestamp of last check
  detail?: string;            // safe, redacted, bounded detail
}
```

`unknown` is a real state: unreachable, timeout, or not yet checked. FE2 renders it; BE2 produces it.

## 3. Incident extensions

```ts
// extended unions (additive)
export const incidentKinds = [
  'runtime_regression', 'persistent_defect', 'build_failure',   // existing
  'config_drift', 'dependency_failure',                          // new
] as const;

export const incidentStatuses = [
  'detected', 'investigating', 'rolling_back', 'remediating',    // existing
  'recovered', 'pr_opened', 'needs_human', 'remediation_failed', // existing
  'verifying',                                                   // new: action taken, verification in progress
] as const;

export const incidentDecisions = [
  'rollback', 'fix_pr', 'escalate',              // existing
  'restore_revision', 'restore_config', 'restart_dependency',  // new guarded actions
] as const;
```

New **optional** fields on `Incident` (all default-absent so old incidents parse unchanged):

```ts
export interface EvidenceItem {
  source: string;            // e.g. 'health_probe', 'runtime_logs', 'revision_check'
  observation: string;       // what was seen (redacted, bounded)
  at: string;                // ISO timestamp
  serviceId?: string;
  inferenceOf?: number;      // index into evidence[] this item infers from; absent = pure observation
}

export interface ActionRecord {
  kind: IncidentDecision;             // one of the guarded actions
  target: string;                     // service ID or resource ID
  dryRun: boolean;
  policyResult: 'allowed' | 'denied' | 'dry_run';
  policyReason: string;
  attempt: number;                    // 1-based; broker enforces <= 1 automatic attempt per incident
  executionResult?: 'succeeded' | 'failed' | 'not_executed';
  at: string;
}

export interface VerificationRecord {
  serviceChecks: { serviceId: string; result: 'pass' | 'fail' | 'unknown'; at: string }[];
  journeyCheck: { result: 'pass' | 'fail' | 'unknown'; at: string; detail?: string };
  passed: boolean;                    // true only if every check passed
}

export interface EscalationRecord {
  reason: string;                     // ambiguous evidence | missing known-good | policy denial | action failure | failed verification
  at: string;
  recommendedNextStep: string;
  notificationOutcome?: 'sent' | 'failed' | 'not_attempted';
}
```

`Incident` gains: `evidenceItems?: EvidenceItem[]`, `actions?: ActionRecord[]`, `verification?: VerificationRecord`, `escalation?: EscalationRecord`, and timing fields (§6). FE1 rule from the plan: **do not show recovery unless `verification.passed` is true.**

## 4. Timing (new optional fields, never invented)

```ts
faultInjectedAt?: string;    // written by BE1's injector only; absent if unknown
detectedAt: string;          // existing
decidedAt?: string;          // policy decision time
actionAt?: string;           // execution start
verifiedRecoveryAt?: string; // set only when verification passed
```

Durations (`faultToDetectionMs`, `detectionToRecoveryMs`, `faultToRecoveryMs`) are **computed at read time** by the API from these fields; missing inputs → field absent, never zero or guessed.

## 5. Action broker boundary (BE2-internal, but contracts are shared)

The broker is the only path from Sentinel to the demo environment. Requests are fixed operations with validated parameters — no arbitrary commands, no Docker socket access from agent/controller code.

```ts
export type BrokerRequest =
  | { kind: 'restore_revision'; target: 'task-api'; revision: string }
  | { kind: 'restore_config'; target: string; key: string; value: string }
  | { kind: 'restart_service'; target: 'dependency' };

export interface BrokerDecision {
  allowed: boolean;
  reason: string;              // always present, also when denied
  dryRun: boolean;
}
```

Broker-enforced invariants (independent of the controller/agent):
- Target allowlist per action kind (e.g. only `dependency` may be restarted).
- Parameter validation against known-good values BE1 exposes (`restore_config` must name a value BE1 published as known-good).
- Max **one** automatic attempt per incident (dry runs do not consume the attempt).
- Every request, allowed or denied, appends an audit record.

Dry run uses the **same** policy evaluation as execution with `dryRun: true`; it returns the proposed operation + decision and performs no mutation.

## 6. BE1 fault/reset API (FE2 + BE2 consume; BE1 owns)

All demo-control endpoints are local-only (bound to localhost / compose network).

| Method & path | Purpose |
| --- | --- |
| `GET /api/demo/services` | `ServiceStatus[]` for all three services |
| `POST /api/demo/faults/bad-deployment` | switch task-api to broken revision |
| `POST /api/demo/faults/bad-config` | apply invalid allowlisted config value |
| `POST /api/demo/faults/dependency-down` | stop/fail the dependency |
| `POST /api/demo/faults/ambiguous` | conflicting-evidence scenario |
| `POST /api/demo/reset` | restore all services to verified known-good |
| `GET /api/demo/state` | current fault state + `faultInjectedAt` timestamps |

Known-good revisions/config values are exposed via a read endpoint so BE2 can satisfy "confirm a known-good version or value before reverting." The injector may record which fault is active for evaluation, but that label must **not** appear in any health/log/change evidence Sentinel reads.

## 7. BE2 dashboard APIs (FE1 consumes)

Existing: `GET /api/incidents`, `GET /api/incidents/:id`, agent-run SSE (unchanged).

| Method & path | Purpose |
| --- | --- |
| `GET /api/services` | `ServiceStatus[]` |
| `POST /api/actions/dry-run` | body: `BrokerRequest`; returns `BrokerDecision` + proposed `ActionRecord`; no mutation |
| `GET /api/incidents/:id/timeline` | unified events + actions + verification + escalation (or embedded in detail response) |

## 8. Decisions needed from the team

1. Service IDs/ports (§1) — BE1 proposes, all confirm.
2. Additive-union approach vs. a separate demo `SentinelIncident` type — BE2 recommends additive (§3).
3. Does FE1 need per-check verification detail in the UI, or just pass/fail + evidence? (§3)
4. Demo detection threshold: existing 3-consecutive-failure rule is slow for a live demo. Propose: 2 consecutive for demo profile, 3 for cloud profile. BE2 decides defaults; team confirms.
5. Escalation notification channel for the demo (Slack webhook? none, dashboard-only?) — plan says notification failures must not hide incidents.
