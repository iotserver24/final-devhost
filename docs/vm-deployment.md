# VM deployment and rollback

Sentinel can watch and roll back an application deployed on a VM. The safe
architecture is a **restricted VM agent**: a small service on the VM that
exposes a fixed set of operations for one allowlisted application. The
controller never gets SSH, a shell, or the Docker socket.

## Why an agent instead of remote shell

| Option | Risk | Verdict |
| --- | --- | --- |
| Controller opens SSH and runs commands | Any command the controller (or an exploited controller) can express | Rejected |
| Controller talks to the Docker socket over the network | Effectively root on the host | Rejected |
| **Restricted agent exposing fixed operations** | Only start/rollback/status/logs for one named app | **Chosen** |

Tradeoff: the agent is one more component to deploy and keep patched, and it is
the only thing on the VM that needs Docker access. In exchange, an agent
compromise or a controller bug cannot, for example, delete a volume or run an
arbitrary image.

## Agent contract

```text
GET  /v1/apps/{app}/status      → { current: {id,image,deployedAt,healthy}, previous: {id,image,deployedAt} }
POST /v1/apps/{app}/rollback    { "target": "<previous id>" } only
GET  /v1/apps/{app}/health      → 200 healthy / non-200 unhealthy
GET  /v1/apps/{app}/logs?lines=N → { "lines": ["…"] } bounded
```

Rules the agent must enforce (not the controller):

- `{app}` must be on an agent-side allowlist.
- `rollback.target` must equal the recorded previous deployment.
- Log lines are capped; no full files, no environment dumps.
- Requires a bearer token; refuses without one.

The controller side is `apps/controller/src/vm-provider.ts` and works with the
existing decision engine: the same allowlist, recency, predecessor, and
one-attempt-per-deployment rules apply. There is no VM-specific bypass.

## Configure a VM target

```sh
CONTROLLER_TARGETS='[
  {
    "id": "taskflow-vm",
    "name": "TaskFlow on VM",
    "kind": "vm",
    "environment": "demo",
    "vm": {
      "agentUrl": "https://10.0.0.5:8443",
      "application": "taskflow",
      "healthPath": "/health"
    },
    "rollback": { "enabled": true, "maxAttempts": 1 }
  }
]'
```

`VM_AGENT_URL`, `VM_AGENT_TOKEN`, and `VM_APPLICATION` remain available for a
single-VM setup. The token is read from the environment only and never logged.

## Rollback procedure (dry run first)

1. Identify current and previous:
   - `GET /api/services` shows target status.
   - The VM provider's `planRollback` prints `current`, `previous`, and whether a
     rollback is permitted. **A dry run performs no mutating request.**
2. Confirm evidence: the current deployment is recent, production, and its
   health check fails while a previous deployment is recorded.
3. Request the action through the broker or the monitor's guarded path. The
   broker allows exactly one automatic attempt per incident.
4. Verify: the controller re-probes health **and** runs the user-facing check.
   `recovered` is recorded only when both pass.
5. If verification fails or evidence is insufficient, the incident is set to
   `needs_human` with a reason and a suggested next step. It is not retried.

## Docker and Compose

The controller and the monitored application are separate images and services.

```sh
cp .env.example .env                 # fill placeholders
docker compose up -d controller      # controller only
docker compose --profile demo up -d  # controller + demo app
```

Configurable without source edits: image name/tag, Bun version, GitHub CLI
installation, controller port, data directory, demo app port and image tag, and
fault mode. Neither container runs with `no-new-privileges` disabled, and the
controller is not given the host Docker socket.

### Known-good identification

Build a distinct image tag per version (`sentinel-demo-app:good`,
`sentinel-demo-app:broken`) and run each as a deployment on the VM. The agent
records the image reference and deployment time; the previous tag is the
rollback target. Restoring means starting the previous tag, not rebuilding it.

## What is tested and what is not

| Area | Status |
| --- | --- |
| Provider logic, scoping, guarded rollback, dry-run, bounded logs, credential handling | **Unit tested** against a fake transport (`tests/vm-provider.test.ts`) |
| Agent contract behaviour | **Tested** against `apps/vm-agent` on `127.0.0.1` (`tests/vm-agent.integration.test.ts`) |
| Local rollback of `sentinel-demo-app:broken` to `sentinel-demo-app:good` | **Tested** through the same agent. One rollback, then a second attempt is refused |
| Cloud VM rollout | **Not tested** — the agent above is local, not a remote machine |
| Docker image build and compose profiles | `vm` and `airflow` profiles are defined. Image build of the Next.js demo app was not required for the agent test |

The local check is `bun test apps/controller/tests/vm-agent.integration.test.ts`.
A cloud VM is still a separate deployment: put the same agent on that host with
`VM_AGENT_TOKEN`, allow one application, and point `VM_AGENT_URL` at it.
`docker compose --profile vm up -d vm-agent` starts the agent on `127.0.0.1:8443`
without a Docker socket.