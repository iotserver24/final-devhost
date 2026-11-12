# Incident dashboard — Madvit

Sentinel is a dark local incident control room built with Next.js. It shows probe and deployment evidence, the safety decision, rollback or draft PR status, and live agent activity. The live dashboard requires the controller's `.env` username/password and presents a login before fetching incident data.

Open **Setup** after signing in to connect GitHub, connect Vercel with OAuth, or enter a project-scoped `VERCEL_ACCESS_TOKEN` manually. The Vercel setup also accepts the team ID, project ID, public site link, probe path, and monitor/rollback flags. Settings are stored by the controller; restart the controller after saving to apply monitoring changes. Secret values are never returned to the dashboard.

Use Bun for package management and scripts.
