# Sentry integration (optional)

Sentry issues are attached to incidents as **advisory evidence**. They are never,
on their own, enough to trigger an automated action.

## Configuration

```sh
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project
SENTRY_AUTH_TOKEN=<token>
# SENTRY_BASE_URL=https://sentry.io   # change for self-hosted
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

## Live setup still required

A real Sentry organization, project, and token. Nothing in this repository has
been exercised against a live Sentry account.