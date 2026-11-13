# Team shared environment — Sentinel (PS4)
# Copy to apps/controller/.env and fill in secrets from the team's password manager / private chat.
# NEVER commit real secret values here or anywhere in git.

# --- Core ---
CONTROLLER_HOST=127.0.0.1
CONTROLLER_PORT=8899

# Shared team database (Neon free tier; compute sleeps when idle, first request may take a few seconds)
DATABASE_URL=postgresql://neondb_owner:<NEON_PASSWORD>@ep-aged-lab-az4yzuod-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require

# Dashboard login (change per machine if you like; keep in sync for shared screens)
DASHBOARD_USERNAME=keel
DASHBOARD_PASSWORD=keel-local-demo
DASHBOARD_AUTH_SECRET=

# --- Feature flags: keep OFF until the corresponding demo step ---
CONTROLLER_MONITOR_ENABLED=false
CONTROLLER_ROLLBACK_ENABLED=false
CONTROLLER_REMEDIATION_ENABLED=false

# Polling (demo may want faster; min 1000)
CONTROLLER_POLL_INTERVAL_MS=30000
CONTROLLER_DEPLOYMENT_STATUS_INTERVAL_MS=60000
CONTROLLER_LOGS_INTERVAL_MS=30000
CONTROLLER_PROBE_PATH=/api/tasks

# --- Cloud provider (only if demonstrating the cloud path) ---
CONTROLLER_PLATFORM=vercel
VERCEL_ACCESS_TOKEN=<VERCEL_ACCESS_TOKEN>
VERCEL_PROJECT_ID=prj_mzsgdAEYOn2wRW8E8KLETRIsblsD
VERCEL_PRODUCTION_DOMAIN=testsite-three-iota.vercel.app
VERCEL_TEAM_ID=team_A6lEzmIS4uA1INngR0Lhxuid
CONTROLLER_ROLLBACK_PROJECT_ID=prj_mzsgdAEYOn2wRW8E8KLETRIsblsD

# --- AI remediation (optional E2B draft-PR path; enable only with all REMEDIATOR_* set) ---
REMEDIATOR_REPOSITORY=iotserver24/nexathon
REMEDIATOR_ALLOWED_REPOSITORY=iotserver24/nexathon
REMEDIATOR_ALLOWED_PATH_PREFIX=src/
REMEDIATOR_SETUP_COMMAND="bun install --frozen-lockfile"
REMEDIATOR_REPRODUCE_COMMAND="bun test src/tests/filter.repro.test.ts"
REMEDIATOR_TEST_COMMAND="bun test src/tests"
REMEDIATOR_BUILD_COMMAND="bun run build"
REMEDIATOR_FIXTURE_PATH=src/tests/filter.repro.test.ts
REMEDIATOR_FIXTURE_SOURCE=packages/remediator/fixtures/testsite-filter.repro.ts.txt
REMEDIATOR_MODEL_ID=openai/gpt-6-luna
REMEDIATOR_MODEL_BASE_URL=https://gen.pollinations.ai/v1
REMEDIATOR_MODEL_API_BACKEND=chat_completions
REMEDIATOR_MODEL_API_KEY=<MODEL_API_KEY>
E2B_API_KEY=<E2B_API_KEY>
E2B_REMEDIATOR_TEMPLATE=devhost-fix
GITHUB_READ_TOKEN=<GITHUB_READ_TOKEN>
GH_TOKEN=<GH_TOKEN>

# --- Notifications (optional) ---
SLACK_WEBHOOK_URL=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=

# --- Local CLI token for starting agent runs ---
NEXATHON_RUN_TOKEN=local-demo-token

# --- Secrets checklist (get values from team chat / password manager) ---
# NEON_PASSWORD, VERCEL_ACCESS_TOKEN, MODEL_API_KEY, E2B_API_KEY,
# GITHUB_READ_TOKEN, GH_TOKEN
