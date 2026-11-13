# Sentinel: Problem Statement 4 Implementation Plan

> **Updated 2026-11-12** for the revised problem statement: four failure types are now required (bad deploy, broken config, **resource exhaustion**, failing dependency), and automatic rollback is an explicit demo feature. Scenario table and acceptance matrix below are extended accordingly.

## Goal

Turn Sentinel into a demonstrable incident-response agent for **“The On-Call Engineer That Doesn't Panic.”** Run a multi-service application on a laptop, introduce four distinct failures live, diagnose each using evidence, safely remediate, verify recovery, and measure recovery time. Demonstrate that unsafe actions are blocked and uncertain cases escalate to a human.

Build on the existing controller, dashboard, Supercharge/E2B workflow, and cloud providers. Do not present fixtures, mocked tests, or a draft PR as a live recovered service.

## Team ownership

| Developer | Role | Ownership |
| --- | --- | --- |
| Frontend 1 (FE1) | Incident dashboard | Incident details, evidence, timeline, recovery metrics, and escalation |
| Frontend 2 (FE2) | Demo experience | TaskFlow user interface, service status, fault controls, dry run, and reset |
| Backend 1 (BE1) | Demo infrastructure | Multi-service target, fault injection and reset, health checks, logs, and fault timing |
| Backend 2 (BE2) | Sentinel response | Monitoring, diagnosis, action policy, verification, escalation, and APIs |

Each developer owns the tests relevant to their work. Agree on contracts before implementation and coordinate edits to shared files.

## Architecture and trust boundary

1. TaskFlow consists of a frontend, a task API, and a separate dependency service. The task API must genuinely depend on the dependency for a user-facing operation.
2. Sentinel monitors each service and an end-to-end user journey. It gathers health checks, bounded logs, relevant deployment/configuration changes, and timestamps.
3. The controller evaluates the evidence and requests only approved actions from an action broker.
4. The broker independently enforces target, action, parameter, and retry limits. Do not give the agent or controller unrestricted access to the host Docker socket or arbitrary host commands. If the broker uses the socket internally, isolate it, expose only fixed operations, test rejected requests, and document remaining privileges honestly.
5. After an action, Sentinel checks both service health and the user-facing journey. Mark recovery only when verification succeeds; escalate uncertainty, policy denial, or failed recovery.
6. Supercharge and E2B remain available for an optional code-fix investigation and tested draft PR. A draft PR alone does not prove production recovery.

## Demo scenarios

| Scenario | Controlled fault | Evidence and expected diagnosis | Allowed response | Success verification |
| --- | --- | --- | --- | --- |
| Bad deployment | Switch the task API to a broken demo revision. | Current revision fails; a recent deployment changed; the known-good predecessor passes the equivalent check. | Restore the known-good revision once. | Task API health and a real TaskFlow request pass. |
| Broken configuration | Apply an invalid allowlisted configuration value. | A recent config change correlates with a service error; a known-good value exists. | Restore that value once. | Service health and the affected user journey pass. |
| Failing dependency | Stop or deliberately fail the dependency service. | Dependency health fails and the task API reports a dependency error. | Restart the allowlisted dependency once. | Dependency health and the TaskFlow operation pass. |
| Resource exhaustion | Consume memory/CPU on the task API until it slows or restarts. | Health degrades or OOM events appear in logs while error rates rise; no deployment or config change correlates. | Restart the affected allowlisted service once. | Service health and the TaskFlow operation pass. |
| Unsafe or ambiguous case | Produce conflicting evidence or request an action against an unrelated target. | Evidence is insufficient or policy rejects the action. | Do not mutate; escalate. | Show rejection, audit entry, and human-attention state. |

The injector may record the expected answer for evaluation, but must not give that answer to Sentinel's diagnosis logic. Diagnosis must use observed evidence. If an action cannot be safely automated, propose it for human approval and explain the limitation.

## FE1 — Incident dashboard

**Own:** incident list/detail, evidence, timeline, policy decisions, recovery metrics, and escalation. Coordinate API types with BE2.

- Show affected services, status, symptoms, likely cause, and uncertainty. Distinguish observation from inference.
- Show a timeline of detection, diagnosis, proposed action, policy decision, execution, verification, and escalation.
- Display the target, dry-run status, action result, audit trail, and reasons for blocked actions.
- Display detection-to-verified-recovery time and, when the actual fault time is known, fault-to-verified-recovery time. Do not show recovery for an unverified incident.
- Add a prominent **Needs human attention** state with a reason and suggested next step.
- Handle loading, missing evidence, API errors, redacted logs, and long output. Keep the incident understandable within a minute.
- Test verified recovery, denial, uncertainty, missing timestamps, and failed verification.

**Done when:** a judge can see a real incident's evidence, cause, action, verification, and timing without relying on fixtures.

## FE2 — Demo application and controls

**Own:** TaskFlow user journey and demo controls. Coordinate the fault API with BE1 and dry-run behavior with BE2.

- Make the user-facing workflow genuinely depend on the task API and dependency service; do not simulate service status in the browser.
- Show each service's real health, last check, and end-to-end request result, including unknown/unreachable states.
- Add local-only controls for the four faults, an unsafe/ambiguous case, and reset. Show current state and errors.
- Add a clearly labelled dry-run control backed by BE2's real policy evaluation; it must not change the target.
- Disable conflicting operations while injection or reset is running. Ensure demo controls and reset are restricted to demo resources.
- Add focused tests for fault controls, reset, unreachable services, and dry-run display.

**Done when:** a judge can see TaskFlow working, introduce a fault, observe its real impact, and reset the demo without editing code or restarting everything manually.

## BE1 — Multi-service target and faults

**Own:** target services, local Compose setup, fault injection/reset, service health/logs, and injection timestamps.

- Implement the frontend, task API, and real dependency service. Document service names, ports, dependencies, health checks, and startup commands.
- Make Docker Compose start the laptop-scale demo with predictable readiness checks and reproducible initial state.
- Implement all four faults and reset each independently to a verified known-good state.
- Provide observable service identity, health, bounded logs, deployment/configuration revision, and relevant change timestamps. Keep the expected fault label out of diagnosis evidence.
- Record the actual fault-injection time separately from Sentinel's first-detection time.
- Provide narrowly scoped ways for the action broker to restore a known-good revision/configuration and restart the designated dependency.
- Document resource requirements and offline startup. Add integration checks proving each fault affects the intended user journey and reset restores it.

**Done when:** each fault can be introduced and reset independently on a laptop, with useful real evidence available to Sentinel.

## BE2 — Monitoring, safety, and response

**Own:** controller integration, local adapter/action broker, diagnosis, policy enforcement, verification, escalation, persisted incident data, and dashboard APIs.

- Monitor each service and an end-to-end operation. Associate signals and changes with incidents; provide evidence-backed likely causes or an explicit unknown.
- Connect BE1's real signals through a local adapter while retaining existing cloud provider support.
- Enforce explicit target/action allowlists, validated parameters, bounded operations, one automatic attempt per incident, and audit records independently of the agent. Reject arbitrary commands and unrelated targets.
- Implement dry run through the same policy path as execution, returning the proposed operation and decision without mutation.
- Confirm a known-good version or value before reverting. Verify service health and the user journey after every action. Do not claim recovery or repeatedly mutate when verification fails.
- Escalate ambiguous evidence, missing known-good state, rejected actions, action failures, and failed verification. Surface reasons and record notification failures separately.
- Record fault, detection, decision, action, verification, and escalation timestamps when available. Calculate durations without inventing unknown timestamps.
- Expose incident, service-status, action/dry-run, and event interfaces; validate requests and restrict demo operations to the local environment.
- Test the four diagnosis/action paths, forbidden actions, dry-run no-mutation, single attempt, failed verification, escalation, and timing. Run integration tests with BE1's services.
- Document actual credentials and permissions; demonstrate denied actions. Avoid unsupported claims of absolute security or least privilege.

**Done when:** all four faults produce evidence-backed diagnoses and guarded, verified responses; the unsafe case is denied or escalated; and the dashboard receives accurate state and timings.

## Shared interface agreement

Before implementation, BE1 and BE2 agree on service identity, health, logs, recent-change evidence, fault/reset behavior, and broker requests. BE2 and both frontend developers agree on endpoint names and request/response examples. Use `packages/contracts` as the shared source of truth where appropriate. These fields are proposed, not claims about existing implementation.

| Data | Minimum fields |
| --- | --- |
| Service status | Service ID, health state (`healthy`, `unhealthy`, `unknown`), checked time, safe detail |
| Incident | ID, affected services, status, observed symptoms, likely cause or unknown, evidence, timestamps |
| Evidence | Source, observation, timestamp, associated service; distinguish observations from inferences |
| Action | Kind, target, dry-run flag, policy result/reason, attempt count, execution result |
| Verification | Individual service and user-journey checks, timestamps, pass/fail/unknown |
| Escalation | Reason, time, recommended human next step, notification outcome if attempted |
| Timing | Fault time if known, detection time, action times, verified recovery time if applicable |

## Work sequence

1. **All four:** agree on service names, fault behavior, ownership, endpoints, and event shapes.
2. **BE1:** implement services and fault/reset interfaces. **BE2:** define the broker policy and develop against test doubles. **FE1 and FE2:** build against agreed contracts using clearly labelled development fixtures.
3. **BE1 and BE2:** connect real signals, actions, and verification; test boundaries before enabling automatic actions.
4. **FE1 and FE2:** connect real APIs and handle errors. Keep fixture mode visibly labelled.
5. **All four:** run the full acceptance matrix after a clean reset, record actual results, and fix integration issues.
6. **Optional:** add Sentry as an evidence source and demonstrate a Supercharge/E2B tested draft PR. Neither should be required for the three local scenarios.

## Final acceptance matrix

Record actual evidence, expected and actual diagnosis, action and policy decision, before/after health, user-journey verification, outcome, and measured times. Report failed runs honestly.

| Run | Fault-to-detection | Detection-to-verified recovery | Fault-to-verified recovery | Result and evidence |
| --- | --- | --- | --- | --- |
| Bad deployment | To measure | To measure | To measure | Pending |
| Broken configuration | To measure | To measure | To measure | Pending |
| Failing dependency | To measure | To measure | To measure | Pending |
| Resource exhaustion | To measure | To measure | To measure | Pending |
| Ambiguous or forbidden action | To measure | Not applicable unless recovered | Not applicable | Pending: prove no unauthorized mutation and show escalation |

**Definition of done:** All services run on a laptop; each of the four faults is introduced live, correctly diagnosed from evidence, safely remediated, and independently verified; recovery times are shown; dry run makes no changes; forbidden actions are rejected; ambiguous/failed cases escalate; and the dashboard explains the outcome. Document exact commands, permissions, and limitations, and distinguish local results from cloud or E2B results.

## Sponsor tools

- **Supercharge and E2B:** Existing sandboxed investigation and patch validation; use for an optional code-fix path. A draft PR requires review and is not itself a recovered service.
- **Sentry:** Optional exception evidence; the local demo should still run without it.
- **Slack/SMTP:** Optional notification delivery; failures must not hide incidents.
- **PostHog, Amplitude, MongoDB, Clerk, Free.ai, OpenScale, Wiro:** Consider only if a real requirement and available access justify the integration. Avoid adding services solely because credits exist.
