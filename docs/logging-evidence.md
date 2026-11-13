# Logging and incident evidence

## What is captured

Incident records (`packages/contracts`) and evidence carry:

| Field | Where |
| --- | --- |
| Timestamp | `IncidentEvent.at`, `Incident.detectedAt`, `Incident.timing` |
| Service identity | `projectId`, `affectedServices`, `targetId` |
| HTTP status and route | evidence lines such as `HTTP 503 from host/path`, `classification` events |
| Deployment/version | `deploymentId`, `commitSha`, `deploymentUrl` |
| Error category/severity | `Incident.kind`, `classification`, log `level` |
| Bounded stack traces | `Incident.runtimeLogs` (redacted, JSON per line) |
| Health-check results | `verification.serviceChecks` |
| Diagnosis evidence | `evidence[]` and `evidenceItems[]` (observations vs `inferenceOf`) |
| Proposed/executed actions | `actions[]` (`ActionRecord`) |
| Policy decisions | `actions[].policyResult`, `policyReason`, broker audit |
| Verification | `verification.passed`, per-service and journey checks |
| Escalation | `escalation` (reason, next step, notification outcome) |
| Sentinel evidence | `evidenceSources` includes `sentry` when attached |

## What is excluded

- Passwords, authorization headers, API keys, cookies, and tokens. The shared
  `redact`/`redactFull` helpers in `packages/notifier/src/format.ts` strip
  bearer/basic credentials, GitHub/Slack/OpenAI-shaped tokens, and
  `token=…`/`password=…` pairs before anything is stored or shown.
- Full request and response bodies. Only status, route, and bounded, redacted
  messages are kept.
- Secrets in URLs: query strings and fragments are dropped from action links
  (`safeLink`), and provider requests never embed credentials in a URL.

## Bounds and retention

| Item | Bound |
| --- | --- |
| Evidence line length | 600 characters |
| Evidence entries per incident | 100 |
| Events per incident | 500 |
| Runtime log batch | 5 MB; larger input fails explicitly rather than truncating |
| Stored runtime logs per project | 200 most recent |
| Agent activity entry | 32,000 characters; 500 entries per run |
| Agent runs in memory | 20 newest (all persisted in PostgreSQL) |
| Broker audit entries | 200 in memory |
| Sensitive-operation audit | 500 entries in memory |

Incidents, agent runs, and settings persist in PostgreSQL. The in-memory audit
trails reset when the controller restarts; treat them as operational detail and
use the persisted incident timeline for post-incident review.

## Ignored events

Classified-as-ignored responses (normal 404s) do not create incidents. They are
visible as the monitor's `watch` detail and classification counters rather than
in the incident feed, so a noisy crawl of missing pages cannot flood the queue.

## Removing or widening retention

Retention constants are deliberately conservative. Increasing them is a code
change in `monitor.ts` / `activity.ts`; there is no environment override,
because unbounded growth is the failure mode this policy exists to prevent.