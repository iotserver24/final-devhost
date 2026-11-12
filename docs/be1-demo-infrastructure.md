# BE1 — Demo infrastructure

## Services

| Service | Image/Build | Port | Health check | Purpose |
| --- | --- | --- | --- | --- |
| controller | root Dockerfile | 8787 | `/api/auth/session` | Sentinel controller API |
| postgres | postgres:13 | 5432 | `pg_isready` | Controller persistent state |
| sample (TaskFlow) | apps/sample/Dockerfile | 3000 | `/api/health` | Demo target frontend + task API |
| dependency | apps/dependency/Dockerfile | 4100 | `/health` | Real dependency of the task API |

## Startup

```sh
docker compose up -d
```

All services have readiness healthchecks; compose starts dependents only when
dependencies are healthy, giving a reproducible initial state.

## Fault injection (runtime, no restart)

| Endpoint | Method | Body | Effect |
| --- | --- | --- | --- |
| `/api/faults` | GET | — | Current fault kind + injection timestamp |
| `/api/faults` | POST | `{"kind":"bad-deployment"}` | Task API health + tasks fail (500) |
| `/api/faults` | POST | `{"kind":"broken-config"}` | Tasks fail with config error (500) |
| `/api/faults` | POST | `{"kind":"failing-dependency"}` | Tasks report dependency down (503) |
| `/api/faults` | DELETE | — | Reset all faults to known-good state |

The injection timestamp (`injectedAt`) is recorded separately from any
detection time observed by Sentinel. The fault label is not exposed through
health/tasks evidence — only the resulting behavior is observable.

## Resource requirements

Laptop-scale: 4 containers, ~1 GB RAM total. Offline startup works once
images are pulled (`docker compose pull` beforehand).
