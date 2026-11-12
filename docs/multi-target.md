# Multiple monitored targets

`apps/controller/src/targets.ts` defines a declarative target list. Each target
has its own provider, routes, thresholds, rollback policy, and optional
notification label.

## Configuration

```sh
CONTROLLER_TARGETS='[
  {
    "id": "web-prod",
    "name": "Marketing site",
    "kind": "http",
    "environment": "prod",
    "provider": "vercel",
    "url": "https://www.example.test",
    "probePath": "/api/health",
    "criticalRoutes": ["/api/health"],
    "failureThreshold": 3,
    "rollback": { "enabled": true, "maxAttempts": 1 },
    "notify": "oncall-web"
  },
  {
    "id": "taskflow-vm",
    "name": "TaskFlow on VM",
    "kind": "vm",
    "environment": "demo",
    "vm": { "agentUrl": "https://10.0.0.5:8443", "application": "taskflow", "healthPath": "/health" },
    "rollback": { "enabled": true, "maxAttempts": 1 }
  }
]'
```

Validation rules (each violation drops only that target, with a problem message):

- `id` must match `^[a-z0-9][a-z0-9-]{0,40}$` and be unique.
- `url` / `agentUrl` must not embed credentials; plain HTTP is allowed only for
  localhost.
- `probePath` and `healthPath` must be absolute routes without `..`.
- `vm.application` must be a safe identifier.
- At most 25 targets; over that, the first 25 are used and a problem is logged.

## Isolation guarantees

- Incident IDs include the target's project/application identity, so incidents,
  failure streaks, and rollback claims never cross targets.
- The monitor loops over targets and catches per-target errors. An unreachable
  provider for one target is reported as `unavailable` and the loop continues
  with the next target.
- A provider instance is scoped to one project/application and throws if asked
  to act on another (`assertProject`), so an action cannot spill over.
- Rollback claims are stored per deployment ID, not per run.

## Backward compatibility

With no `CONTROLLER_TARGETS`, the controller derives a single target from
`VERCEL_PRODUCTION_DOMAIN` + `CONTROLLER_PROBE_PATH` (id `primary`), so existing
single-target deployments keep working unchanged. There is no data migration:
existing incidents have no `targetId` and remain readable.

## Dashboard

`GET /api/services` returns per-service status. Incidents carry `targetId` and
`evidenceSources`; the dashboard filters by target and shows the evidence source
(for example `sentry`) next to each incident.

## Tests

`apps/controller/tests/targets.test.ts` covers two independent targets, dropping
a broken target without losing the healthy one, duplicate/unsafe ids, VM target
validation, per-target thresholds, and the legacy single-target fallback.