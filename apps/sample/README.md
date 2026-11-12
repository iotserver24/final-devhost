# TaskFlow — Nexathon Sample App

TaskFlow is the deliberately breakable Next.js + TypeScript target used to
demonstrate Nexathon incident detection and remediation. It is deployed
separately from the incident dashboard so a target rollback cannot take down
the dashboard.

## Requirements and setup

- Bun 1.3.11 or later (the monorepo package manager)
- Node.js 20.9 or later
- A Vercel account for deployment

From the monorepo root, install workspace dependencies:

```bash
bun install
```

The workspace package name is `@nexathon/sample`; its dependencies and scripts
are declared in this directory's `package.json`.

## Local development

Start the development server from the monorepo root:

```bash
bun run --filter @nexathon/sample dev
```

Open <http://localhost:3000>. The demo data is local to this app.

## API endpoints

- `GET /api/health` — service health probe
- `GET /api/tasks` — task list and the main controller probe
- `GET /api/tasks/summary` — task counts by status

For example:

```bash
curl -i http://localhost:3000/api/health
curl -i http://localhost:3000/api/tasks
curl -i http://localhost:3000/api/tasks/summary
```

## Fault scenarios

`DEMO_FAULT_MODE` controls deterministic server-side fault scenarios. The
default is `healthy`; no public query parameter or unauthenticated control can
trigger a fault. Set the variable in the process environment before starting
the app, then restart the server:

| Value | Behavior |
| --- | --- |
| `healthy` (default) | All three API routes return successful responses. |
| `runtime` | `/api/health` and `/api/tasks` return HTTP 500, simulating a fresh runtime regression; the summary route remains healthy. |
| `persistent` | `/api/tasks` returns HTTP 500; health and summary remain healthy, modeling an issue present in both compared revisions. |

PowerShell example:

```powershell
$env:DEMO_FAULT_MODE = "runtime"
bun run --filter @nexathon/sample dev
```

Unset the variable or set it to `healthy` to restore normal behavior. These
switches are for the isolated demo target only. Never enable them on an
unrelated or real production project.

For the most realistic rollback demonstration:

1. Deploy healthy code and save its immutable deployment URL.
2. Deploy a deliberately failing revision.
3. Let the local controller compare the current and previous immutable URLs.
4. Roll back only when the current deployment belongs to the allowlisted demo
   project, the predecessor passes the same probe, and the controller's other
   safeguards pass.

Vercel environment-variable changes generally require a new deployment. Keep
fault configuration consistent across compared revisions.

## Test and build

Run the sample package's API scenario tests and static checks from the root:

```bash
bun run --filter @nexathon/sample test
bun run --filter @nexathon/sample lint
bun run --filter @nexathon/sample typecheck
bun run --filter @nexathon/sample build
```

## Deploy to Vercel

1. Push the monorepo to GitHub and import it into Vercel.
2. Set the Vercel **Root Directory** to `apps/sample`.
3. Deploy with `DEMO_FAULT_MODE=healthy`, or leave it unset.
4. Verify `/api/health` and `/api/tasks` on the deployment URL.

The existing `vercel.json` selects Vercel Functions' Bun runtime (Beta).

## Safety

- Keep the controller local and bind its API to localhost for the demo.
- Keep Vercel rollback credentials in the controller only.
- Do not commit real `.env` files, API tokens, or webhook URLs.
- This sample contains no production data and no user authentication.
