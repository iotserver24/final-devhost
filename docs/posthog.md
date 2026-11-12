# PostHog integration (optional)

PostHog error-tracking issues are advisory evidence. They never, on their own,
start a rollback or another automated action.

## Configuration

```sh
POSTHOG_PROJECT_ID=731597
POSTHOG_PERSONAL_API_KEY=<personal-api-key>
# POSTHOG_HOST=https://us.posthog.com
```

Use a personal API key with read access to error tracking. Do not put the
public project token (`phc_…`) in the controller. The key is sent only as a
Bearer header and is never written into incident records.

## What it does

- `GET /api/projects/:id/error_tracking/issues/?status=active`
- At most 25 issues, titles capped at 120 characters.
- When an incident is created, matching lines are added and `posthog` is set on
  `evidenceSources`.
- `GET /api/evidence/posthog` returns the same summary for the dashboard.

Missing configuration, HTTP errors, rate limits, and unexpected payloads return
no evidence and do not stop monitoring.

## Account used

The connected PostHog account cannot create a new organization from these tools.
A separate project named Sentinel (`731597`) was created inside the existing
organization, apart from Default project `691690`. That project currently has
no error-tracking issues. A personal API key is still required before the
controller can query it.

## Tests

`apps/controller/tests/posthog.test.ts` uses a mocked transport.
