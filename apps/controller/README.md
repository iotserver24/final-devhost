# Local controller — Ronit

The controller provides PostgreSQL incident/probe-streak/rollback-claim storage, a read-only incidents API, a periodic worker, and runtime monitors for Vercel, Railway, Render, and Coolify. The monitor supports same-route current/predecessor probes, a three-failure threshold, deployment-log evidence, project/recency checks, one rollback claim per deployment, bounded post-rollback verification, failed-build detection, and optional remediator/notifier dispatch. Monitoring, rollback, and remediation are disabled by default.

## Run locally

From this directory:

```sh
bun run start
```

The API binds only to `127.0.0.1` (default port `8787`). Set `CONTROLLER_PORT` to change the port. Set `DATABASE_URL` to the PostgreSQL connection string; the controller creates its tables on startup. Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` in the controller environment. The dashboard login creates an in-memory session cookie and never stores the password in the browser. Copy `.env.example` to an untracked `.env` for local configuration; monitoring and rollback remain disabled unless explicitly enabled.

- `GET /api/incidents` lists up to 500 incidents.
- `GET /api/incidents/:id` returns the incident including event history.
- `GET /api/agent/runs` lists the in-memory agent runs of this process.
- `GET /api/agent/runs/:id` returns one run with its events.
- `GET /api/agent/runs/:id/events` streams safe progress as server-sent events.
- `POST /api/internal/agent-runs` starts a run; it needs the `NEXATHON_RUN_TOKEN` bearer token and is refused for any request carrying an `Origin` header.
- Other methods are rejected; no endpoint can roll back production or merge code.

## Vercel runtime logs

Runtime log pulls use the same stored-log transport as Vercel CLI:
`https://vercel.com/api/logs/request-logs`. The controller resolves and caches
`ownerId` from the project's `accountId`; omitting it produces HTTP 400 with
“missing required property `ownerId`”. This is an internal dashboard endpoint,
so its request format can change independently of the documented REST API.
The deployment `runtime-logs` REST endpoint is a live stream rather than this
historical query.

The provider defaults to a one-minute window. Scheduled monitoring pulls every
`CONTROLLER_LOGS_INTERVAL_MS` (60 seconds by default) with 30 seconds of overlap
to allow for ingestion delays; stored event IDs deduplicate overlapping logs.
Queries stay within Hobby's one-hour retention and follow up to ten pages.
When the same error occurs at least three times in a single fetched batch,
incident handling starts on that pull. Counts do not accumulate across pulls;
duplicate log IDs do not inflate the count, and an entirely old batch cannot
trigger again. HTTP health probes still require three consecutive failures.
The incident and fix agent receive the complete fetched runtime batch, including
redacted stack traces and non-error context, separately from short incident
summaries. Agent input over 5 MB fails explicitly rather than truncating logs.
Errors include the endpoint and redacted Vercel validation details. Restart the
controller after updating the code to use the corrected request format.

## Automatic fix attempts

Confirmed incidents proceed to repository investigation even when rollback is
not justified (old deployment, missing predecessor, conflicting evidence, or
rollback disabled). A failed or previously claimed rollback also proceeds to
remediation without another rollback. The agent receives the exact incident
revision, diagnostic evidence, and full redacted runtime log batch.

If the configured reproduction test passes, the agent still reads the source
and adds an incident-specific regression test. The controller checks that test
against the original and patched source before allowing a PR. Fix failures use
`remediation_failed` with the concrete error in the timeline, rather than a
human-approval state. Later confirmed observations retry failed attempts up to
three total remediation attempts per incident. Legacy `needs_human` incidents
are eligible for the same automatic retries. Missing credentials or sandbox
configuration remain explicit failures; the UI does not claim a fix is running.

## Watching an agent work

The dashboard's **Agent transcript** panel reads the event stream and saved runs. It shows public assistant progress messages, redacted tool arguments/results, verification output, the final code diff, and the changed-file summary. Filters, expandable details, a run selector, follow controls, and JSON download make completed work inspectable. Runs are never started from the browser, so the token stays in your shell:

```sh
NEXATHON_RUN_TOKEN=<local secret> bun run start:run -- --incident=<incident id> --rehearsal
```

`--rehearsal` walks through the same phases with clearly labeled placeholder messages and touches no model, sandbox or repository — use it to demo the UI without credentials. Omit `--rehearsal` to run the real fix path, which requires `CONTROLLER_REMEDIATION_ENABLED=true` and the dedicated model/E2B/GitHub configuration. Public messages and tool details are redacted before storage. Private internal reasoning is excluded. Individual entries are limited to 32,000 characters with an explicit truncation marker; each run retains its latest 500 entries. The hub keeps the newest 20 runs in memory; PostgreSQL stores runs and retained events for replay after a controller restart.

## Tests

```sh
bun test
```

Set `CONTROLLER_MONITOR_ENABLED=true` to poll the single `VERCEL_PROJECT_ID` every 30 seconds (configurable up to 5 minutes). Supply `VERCEL_ACCESS_TOKEN`, `VERCEL_PRODUCTION_DOMAIN`, and optionally `VERCEL_TEAM_ID`. The token is used only by the local Vercel REST client and is never logged. To permit rollback, also set `CONTROLLER_ROLLBACK_ENABLED=true` and make `CONTROLLER_ROLLBACK_PROJECT_ID` exactly match `VERCEL_PROJECT_ID`; use only the dedicated demo project. Otherwise, failures proceed to repository investigation and fix-PR remediation without rollback. The adapter rechecks the active alias and immediate predecessor before making the rollback request. See the root README for rollback behavior and Vercel's production-domain caveat.
Set `CONTROLLER_MONITOR_ENABLED=true` and choose one provider with `CONTROLLER_PLATFORM` (`vercel`, `railway`, `render`, or `coolify`). Deployment status is checked every 60 seconds by default via `CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS`; the runtime probe runs every 30 seconds by default. The corresponding fields are documented in `.env.example`: Railway needs its token/project/service (and optional environment), Render needs an API key/owner/service, and Coolify needs a trusted control-plane URL/token/application UUID. Each adapter retrieves a bounded deployment-log excerpt for incident evidence. To permit rollback, set `CONTROLLER_ROLLBACK_ENABLED=true` and make `CONTROLLER_ROLLBACK_PROJECT_ID` exactly match the selected service/application ID. Otherwise failures proceed to repository investigation and fix-PR remediation without rollback. Every adapter rechecks the active deployment and immediate predecessor before issuing a rollback.
Set `CONTROLLER_MONITOR_ENABLED=true` to poll the single `VERCEL_PROJECT_ID` every 30 seconds (configurable up to 5 minutes). Deployment status is checked every 60 seconds by default via `CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS`. Supply `VERCEL_ACCESS_TOKEN`, `VERCEL_PRODUCTION_DOMAIN`, and optionally `VERCEL_TEAM_ID`. The token is used only by the local Vercel REST client and is never logged. To permit rollback, also set `CONTROLLER_ROLLBACK_ENABLED=true` and make `CONTROLLER_ROLLBACK_PROJECT_ID` exactly match `VERCEL_PROJECT_ID`; use only the dedicated demo project. Otherwise, failures proceed to repository investigation and fix-PR remediation without rollback. The adapter rechecks the active alias and immediate predecessor before making the rollback request. See the root README for rollback behavior and Vercel's production-domain caveat.

Set `CONTROLLER_REMEDIATION_ENABLED=true` only when the E2B template, dedicated
model key, read-only GitHub token, and controller-only `GH_TOKEN` are ready.
The trusted `REMEDIATOR_*_COMMAND` values are never read from incident or model
input. The controller uploads the configured regression fixture into E2B,
requires failing-before/passing-after evidence, and publishes only a draft PR.
Slack is optional; missing or failed delivery is recorded on the incident and
never retries production actions.
