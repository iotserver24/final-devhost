# HTTP error classification

A probe result is not simply pass/fail. The same status code means different
things depending on the route, how often it repeats, and the baseline. The
policy lives in `apps/controller/src/classify.ts` and is pure and unit tested.

## Default policy

| Status | Default treatment | Notes |
| --- | --- | --- |
| 2xx, 3xx | healthy | Nothing to do. |
| 404 on a non-critical route | **ignored** | Normal missing pages are sampled as noise, never paged. |
| 404 on a critical route | **incident** | The route is expected to exist. |
| 404 spike above baseline | **incident** | Volume at 5x the baseline (floor 10) indicates a real problem. |
| 400, 405, 409, 410, 422 | ignored once, warning when repeated | Client mistakes. |
| 401, 403 | warning; **incident** when repeated on a critical route | Repeated auth failures usually mean configuration or credentials. |
| 408, 429 | warning; **incident** when repeated on a critical route | Transient by nature. |
| 5xx | warning; **incident** once repeated (3 by default) | A single server error is never enough to act. |
| No response | **unknown** | Never actionable without other evidence. |

Only `incident` permits an automated remediation attempt. `warning` and
`unknown` are recorded; `unknown` escalates when other evidence is missing.

The controller already requires three consecutive failures before it considers
an action, so the classification gate is a second, independent check.

## Changing the policy

All values are environment variables; no code changes are needed.

```sh
CONTROLLER_IGNORED_STATUSES=404
CONTROLLER_WARNING_STATUSES=400,401,403,405,408,409,410,422,429
CONTROLLER_INCIDENT_STATUSES=500,501,502,503,504,507,508
CONTROLLER_CRITICAL_ROUTES=/api/health,/api/tasks
CONTROLLER_REPEAT_THRESHOLD=3
CONTROLLER_404_SPIKE_MULTIPLIER=5
```

Malformed values do not throw: the affected field falls back to the default and
the controller logs which variable was ignored, because a typo must not stop
monitoring.

Per-target overrides are available through `CONTROLLER_TARGETS` (see
`docs/multi-target.md`), where each target can list its own `criticalRoutes`.

## Backwards compatibility

Providers that cannot report a status code (for example an older adapter that
only returns pass/fail) keep the previous behaviour: after the failure
threshold the incident proceeds. The classifier engages whenever
`ProbeResponse.statusCode` is present, which all built-in HTTP providers now
supply.

## What is not covered

- Error classification applies to probe responses, not to application logs. Log
  signals keep their existing repeat-based rule.
- The 404 spike check needs a baseline. Without one the controller cannot
  distinguish a spike from normal traffic.