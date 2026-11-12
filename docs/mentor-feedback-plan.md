# Mentor feedback: implementation plan (actual codebase)

## Requirement → existing code

| # | Requirement | Status before this work | Where |
| --- | --- | --- | --- |
| 1 | HTTP error classification | **Missing.** Probes are pass/fail on `response.ok`; any non-2xx is a failure candidate. | `monitor.ts` `checkProject`, providers' `probe()` |
| 2 | Logging / evidence | **Partial.** Redaction, 600-char evidence caps, 5 MB log cap, bounded event history exist. Missing: explicit capture list, retention docs, per-source metrics. | `notifier/src/format.ts` `redact`, `monitor.ts` `evidence()` |
| 3 | Dependency / import policy | **Partial.** Repository + subtree allowlist, forbidden path segments, patch size, changed-file caps, regression-test preservation. **Missing:** dependency and import allow/deny policy. | `remediator/src/validation.ts`, `pr-publisher.ts` |
| 4 | PR comment follow-up | **Partial.** Webhook signature verification exists; no comment handler, no idempotency, no sandbox resume/fallback. | `github-app.ts` `verifyGithubWebhook`, `server.ts` webhook route |
| 5 | VM deployment + rollback | **Missing.** Provider abstraction is HTTP/API-shaped only. | `monitor.ts` `DeploymentProvider` |
| 6 | Docker / VM deployability | **Partial.** Single-service `Dockerfile` + `docker-compose.yml`, no VM guide. | repo root |
| 7 | Multi-target | **Partial.** Worker loops over `projectIds`, streaks/claims are keyed per project, but one provider/config per process. | `worker.ts`, `incident-store.ts` |
| 8 | Sentry evidence | **Missing.** | — |
| 9 | AuthN vs AuthZ | **Partial.** HMAC cookie, HttpOnly, SameSite=Lax, timing-safe compare, body cap. **Missing:** roles, rate limiting, audit of sensitive ops. | `auth.ts` |
| 10 | Dashboard | **Partial.** Incident list/detail, agent transcript, setup. Missing: target filter, classification display, Sentry source, role-aware controls. | `apps/dashboard` |
| 11 | Demo scenarios | **Missing** as documented acceptance matrix. | `docs/` |

## Phases (build order)

1. **Classification** (`classify.ts`) — pure, configurable policy; tests for 404/4xx/5xx/unknown. Wire into monitor as a gate that preserves existing provider behavior when no status code is available.
2. **Evidence/logging** — document the capture/exclusion policy; add classification + source tags to evidence; bounded sampling counters.
3. **Dependency policy** (`dependency-policy.ts` in remediator) — manifest + import checks, policy-file tamper detection, wired into `validatePatch`/`publishDraftPr`; tests.
4. **Multi-target** (`targets.ts`) — declarative target list, per-target isolation, failure isolation; tests.
5. **VM provider** (`vm-provider.ts`) — restricted agent API (fixed operations), dry-run, bounded logs, rollback claim, verification; fake transport tests.
6. **Sentry** (`sentry.ts`) — optional evidence source, mocked tests, graceful degradation.
7. **AuthZ** — roles (viewer/operator/admin), rate limiting, sensitive-op audit; tests.
8. **Docker/VM docs + demo matrix** — env templates, compose profiles, VM guide, acceptance criteria.

Not attempted here (needs live infrastructure/credentials): real VM end-to-end rollout, live Sentry project, live E2B sandbox resume, live GitHub App comment round-trip. Those are documented as pending with exact requirements.

## Safety invariants preserved

- No credentials in code; all secrets from env, placeholders in templates.
- No unrestricted shell to the agent; broker/agent exposes fixed operations only.
- Existing repository/subtree boundary, patch caps, and "never auto-merge" remain.
- Every new action path keeps dry-run, one-attempt-per-incident, and audit.