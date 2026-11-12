# Authentication and authorization

## Model

Authentication and authorization are separate:

- **Authentication** (`apps/controller/src/auth.ts`) verifies a signed session
  cookie produced by a username/password login.
- **Authorization** (`apps/controller/src/access.ts`) maps a role to the
  operations it may perform.

### Roles

| Role | Can do | Credential |
| --- | --- | --- |
| `viewer` | Read incidents, services, watch status, audit trail | `DASHBOARD_VIEWER_USERNAME` / `DASHBOARD_VIEWER_PASSWORD` |
| `operator` | Viewer actions plus dry runs, broker actions, monitor control | `DASHBOARD_OPERATOR_USERNAME` / `DASHBOARD_OPERATOR_PASSWORD` |
| `admin` | Everything, including settings, credentials, connect/disconnect | `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` |

The admin credential always exists (it is the original single-user login, so
existing deployments keep working). Operator and viewer are optional; omit their
credentials to disable those roles.

Endpoint mapping is centralised in `requiredRole(method, pathname)`:

- `GET /api/incidents`, `/api/services`, `/api/watch`, `/api/audit` → viewer
- `POST /api/actions/*`, `/api/monitor/*`, `/api/internal/agent-runs` → operator
- `GET|POST /api/settings`, `/api/disconnect`, `/api/github/connect`,
  `/api/vercel/connect` → admin

## Session handling

- Signed HMAC-SHA256 cookie: `exp.role.signature`, where the signature covers
  username, expiry, and role.
- `HttpOnly`, `SameSite=Lax`, `Path=/`, 7-day expiry.
- Constant-time comparison for credentials and signatures.
- Changing the role inside the cookie invalidates the signature.
- `DASHBOARD_AUTH_SECRET` (at least 8 characters) should be set so a restart does
  not invalidate sessions; without it the signing key derives from the
  credentials.

## Cross-site protections

- API mutations require a session cookie and are not CORS-enabled; the dashboard
  calls the controller same-origin through its proxy.
- `SameSite=Lax` blocks cross-site POSTs in modern browsers.
- `POST /api/internal/agent-runs` additionally rejects any request carrying an
  `Origin` header, so a browser cannot start an agent run.
- Login bodies are capped at 2 KB.

## Rate limiting

| Operation | Default | Override |
| --- | --- | --- |
| Login attempts | 10 per client per 5 minutes | `CONTROLLER_LOGIN_RATE_LIMIT` |
| Sensitive actions | 30 per role+client per minute | `CONTROLLER_ACTION_RATE_LIMIT` |

Rate-limit rejections return `429` with `Retry-After` and are audited.

## Audit trail

Sensitive operations are recorded in memory (bounded to 500 entries) and exposed
at `GET /api/audit` (viewer and above) with `{ at, actor, action, target,
outcome, detail }`. Denials are recorded as well as successes, including role
denials and rate-limit hits.

## Secrets never reach the browser

`GET /api/settings` returns `value: ''` for every field marked `secret`; it only
reports whether a value is configured and where it came from. Credentials entered
in the UI are stored server-side.

## Trust model and limitations

- The controller is designed for a trusted local or private network. Do not
  expose it to the public internet.
- Sessions are stateless: revoking one session before expiry requires changing
  the auth secret (which invalidates all sessions).
- Rate-limit state is in memory, so it resets on restart and is per-instance.
- The audit trail is in memory; persisted review lives in the incident timeline.
- Roles are coarse (three levels). There is no per-target or per-repository
  delegation.
- No external identity provider is required. Clerk is not integrated because
  there is no configured account and no requirement that justifies the
  dependency.

## Tests

`apps/controller/tests/auth.test.ts` (login, cookie protection, stable secret,
non-revealing errors) and `apps/controller/tests/access.test.ts` (role ordering,
endpoint mapping, rate limiting, audit capacity, role-scoped sessions, tampered
and expired cookies).