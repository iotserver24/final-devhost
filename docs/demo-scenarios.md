# Demo scenarios and acceptance criteria

Six repeatable scenarios. Each lists what to do, what must be observed, and the
**actual test status in this repository**. Status legend:

- **UT** — unit test exists and passes
- **MIT** — mocked integration test (fake transport or local stub server)
- **LE2E** — local end-to-end against real local processes
- **LIVE** — requires real VM / GitHub / E2B / Sentry credentials

---

## A. VM bad deployment

1. Start a healthy application on the VM (image `taskflow:v1`).
2. Deploy a broken version (`taskflow:v2`).
3. Sentinel detects it, gathers evidence, and identifies the recent deployment.
4. Guarded rollback restores `taskflow:v1` once.
5. Health **and** the user-facing check pass.
6. The dashboard shows evidence, action, verification, and recovery time.

| Check | Status | Evidence |
| --- | --- | --- |
| Provider reports current/previous deployment | UT | `tests/vm-provider.test.ts` |
| Rollback only to confirmed previous | UT | same |
| Dry run makes no mutating request | UT | same |
| Health probe + failure mapping | UT | same |
| Unavailable VM does not crash monitoring | UT | same (`rejects`, caller isolates) |
| Rollback decision policy (recent, production, predecessor, one attempt) | UT | `tests/decision.test.ts`, `tests/monitor-safety.test.ts` |
| Real VM rollout + rollback | **LIVE — not run** | Needs VM, agent, token |

---

## B. Normal 404

Request a missing, non-critical route.

- Classified `ignored`; no incident, no rollback.
- Visible as monitor detail/classification, not in the incident feed.

| Check | Status |
| --- | --- |
| Normal 404 is ignored | UT `tests/classify.test.ts` |
| Normal 404 creates no incident and no rollback | UT `tests/monitor-classification.test.ts` |
| 404 on a critical route **is** an incident | UT both files |
| 404 spike above baseline is an incident | UT `tests/classify.test.ts` |

---

## C. Critical errors (repeated 5xx)

- A single 5xx is a warning; repeated 5xx past the threshold creates an incident.
- Response is guarded (allowlist, one attempt, verification).

| Check | Status |
| --- | --- |
| Single 5xx is not actionable | UT `tests/classify.test.ts` |
| Repeated 5xx becomes an incident | UT both files |
| Incident action is guarded and verified | UT `tests/monitor-safety.test.ts`, `tests/local-engine.test.ts` |

---

## D. PR follow-up

1. Use a draft PR created by the agent.
2. An authorized reviewer comments `@sentinel <instruction>`.
3. The agent continues, validates, and updates the branch.
4. Show sandbox fallback when the original sandbox is gone.

| Check | Status |
| --- | --- |
| Webhook signature verification | UT (`verifyGithubWebhook`) |
| Author allowlist, repo/installation match, PR-only, mention+instruction | UT `tests/pr-followup.test.ts` |
| Duplicate delivery ignored | UT same |
| Overlapping runs prevented | UT same |
| Sandbox resume/expiry fallback decision | UT same |
| Context rebuilt for a fresh sandbox | UT same |
| Live GitHub delivery + real E2B resume + branch push | **LIVE — not run** |

Without remediation configured the controller returns `executed: false` with an
explicit note, so the demo never claims a sandbox ran.

---

## E. Multiple targets

1. Configure two targets.
2. Break one.
3. Confirm the other stays monitored and unaffected.

| Check | Status |
| --- | --- |
| Two independent targets parsed | UT `tests/targets.test.ts` |
| Broken target dropped, healthy one kept | UT same |
| Per-target rollback policy and thresholds | UT same |
| Legacy single-target fallback | UT same |
| Provider scoped to one application (no cross-target action) | UT `tests/vm-provider.test.ts` |
| Two live targets with one broken, monitored continuously | **LE2E — partially**: local demo engine tests cover isolation; a two-target live loop is not run |

---

## F. Safety rejection

Request an action against a non-allowlisted target, or supply ambiguous evidence.

- The action is blocked with a reason.
- The incident is escalated to `needs_human`.
- No mutation occurs; an audit entry exists.

| Check | Status |
| --- | --- |
| Non-allowlisted target denied | UT `tests/broker.test.ts` |
| Reverting/restoring to an unverified value denied | UT same |
| One automatic attempt per incident | UT same |
| Ambiguous evidence escalates without acting | UT `tests/local-engine.test.ts` |
| Failed verification escalates, no recovery claimed | UT same |
| Every request audited (allowed and denied) | UT `tests/broker.test.ts` |

---

## Aggregate test commands and results

```sh
bun run --cwd apps/controller test
bun run --cwd packages/remediator test
bun run --cwd packages/notifier test
bun run --cwd apps/dashboard test
bun run --cwd apps/sample test
```

See the final summary in the repository README or the response accompanying this
change for the exact pass/fail counts recorded when these were last run.

## Not tested (requires credentials or infrastructure)

- Real VM deployment and rollback (VM + agent + token).
- Live GitHub App webhook delivery and real E2B sandbox resume.
- Live Sentry project and token.
- A cloud provider token for Vercel/Railway/Render/Coolify rollback.

None of these are claimed as working.