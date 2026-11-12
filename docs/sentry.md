# Sentry integration (optional)

Sentry issues are attached to incidents as **advisory evidence**. They are never,
on their own, enough to trigger an automated action.

## Configuration

```sh
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project
SENTRY_AUTH_TOKEN=<token>
# SENTRY_BASE_URL=https://us.sentry.io   # required for the US cloud region; sentry.io redirects are rejected
# SENTRY_ENVIRONMENT=production          # optional; limits evidence to that environment
```

All three of org, project, and token are required; with any missing, Sentry is
reported as not configured and monitoring is unaffected.

## Permissions

Use a token with the smallest scope that can read issues for that one project
(`event:read` and project read access). Do not use an organization-wide or admin
token. The token is sent only in the `Authorization` header and is never placed
in a URL, log line, or incident record.

## What it does

- `SentryClient.recentIssues()` queries unresolved issues for the configured
  project over a lookback window (default 60 minutes, bounded to 24 hours),
  returning at most 25 issues.
- When configured, incident creation attaches up to five bounded evidence lines
  (`Sentry WEB-1: TypeError in checkout (error, 12 events)`) and adds `sentry` to
  `Incident.evidenceSources`.
- `GET /api/evidence/sentry` exposes the same summary to the dashboard, which
  labels the source.

## Failure handling

| Condition | Behaviour |
| --- | --- |
| Not configured | `configured: false`, no evidence, monitoring continues |
| HTTP 429 | `ok: false`, "rate limit reached"; no evidence |
| HTTP 5xx / unreachable | `ok: false` with the reason; no evidence |
| Unexpected payload | `ok: false`, no evidence (never treated as data) |

An evidence outage can never block incident handling: the monitor wraps the call
in a try/catch and proceeds.

## Correlation and limits

- Correlation is by configured project and environment. Sentinel does not use
  Sentry release SHA matching to correlate incidents yet; a Sentry issue is
  context, not proof.
- Because evidence is advisory, a Sentry spike alone will not cause a rollback.
  The probe and log evidence must independently justify the action.
- Event payloads are not stored; only issue id, short id, title, level, and
  count.

## Tests

`apps/controller/tests/sentry.test.ts` uses a mocked transport and covers
mapping, header-only auth, bounded titles, rate limits, downtime, unexpected
payloads, and incomplete configuration.

String event counts from the Sentry API are accepted. A single issue still
does not start a rollback.

## Live account

The connected account is organization `supercharge-ai` (region `https://us.sentry.io`).
A dedicated team and project named `sentinel` were created for this system, separate
from the existing `rust` project. Creating a brand-new Sentry organization is not
available through the connected tools.

Live issue search against `rust` returned unresolved issues (for example `RUST-7`).
The `sentinel` project has no events yet. The controller still needs
`SENTRY_AUTH_TOKEN` in the environment before `/api/evidence/sentry` can call the API.
That token is not stored in this repository.

See also `docs/posthog.md` for the matching PostHog project.