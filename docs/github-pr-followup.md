# GitHub PR comment follow-up

A reviewer comments on an AI pull request and the agent continues the work.
The security-relevant logic lives in `apps/controller/src/pr-followup.ts` and is
unit tested; the webhook is wired in `apps/controller/src/server.ts`.

## Flow

1. Sentinel publishes a draft PR (`publishDraftPr`).
2. A reviewer comments `@sentinel also handle an empty configuration file`.
3. GitHub POSTs an `issue_comment` webhook.
4. The controller verifies the HMAC signature, deduplicates the delivery,
   validates repository/installation/author, parses the instruction, and takes a
   per-PR lock.
5. It chooses a sandbox strategy: resume the previous sandbox if the provider
   supports it and it has not expired, otherwise build context for a fresh one
   from the PR branch, the incident record, and recent review comments.
6. The change is made inside the existing repository subtree and dependency
   policy, and validation runs again.
7. If validation passes the PR branch is updated and a concise result is posted;
   otherwise an honest failure summary is recorded.

## Security properties

| Property | Implementation |
| --- | --- |
| Signature verification | HMAC SHA-256 over the raw body, constant-time compare |
| Author allowlist | `GITHUB_COMMAND_ALLOWLIST` (comma-separated logins) |
| Installation match | `GITHUB_INSTALLATION_ID` when configured |
| Repository match | `REMEDIATOR_ALLOWED_REPOSITORY` / `REMEDIATOR_REPOSITORY` |
| PR only | Comments on plain issues are ignored |
| Explicit trigger | `GITHUB_COMMAND_MENTION` (default `@sentinel`) **plus** a non-empty instruction |
| Untrusted input | Only the instruction text is used; HTML comments stripped; 2000-char cap |
| Duplicate deliveries | Delivery ledger keyed by `X-GitHub-Delivery` |
| Overlapping runs | Per-PR lease lock with a 30-minute TTL |
| Existing limits | Subtree boundary, patch size, file cap, dependency policy, regression-test preservation |
| Never auto-merge | The controller has no merge path |

## Sandbox lifecycle

E2B sandboxes are not guaranteed to be resumable indefinitely. The controller
never assumes they are:

- `E2B_RESUME_SUPPORTED=true` enables the resume path.
- `E2B_LAST_SANDBOX_ID` and `E2B_LAST_SANDBOX_EXPIRES` describe the previous
  sandbox.
- `chooseStrategy` returns `fresh` when resume is unsupported, no sandbox is
  recorded, no expiry is recorded, or the expiry has passed.
- A fresh sandbox receives `FollowupContext`: repository, PR number, head
  branch, instruction, incident id, and the last 10 comments (bounded).

## Setup

1. GitHub App permissions: **Contents: read/write**, **Pull requests:
   read/write**, **Metadata: read** (the existing app manifest already requests
   these).
2. Subscribe to the **`issue_comment`** webhook event in addition to the
   existing `push` and `pull_request` events.
3. Set `GITHUB_WEBHOOK_SECRET` (the app manifest supplies one), and
   `GITHUB_COMMAND_ALLOWLIST`.
4. The webhook URL must be publicly reachable over HTTPS for GitHub to deliver
   events. Locally, use a tunnel; this was not exercised here.

## What is tested and what is not

Unit tested: authorization, signature-independent parsing, ignore rules,
instruction extraction, idempotency, run locking, sandbox fallback, and context
building.

Not tested live: an actual GitHub delivery, a real E2B resume, and pushing an
updated branch. Those need a GitHub App installation, a public webhook URL, E2B
credentials, and a real repository. When remediation is not configured the
controller accepts the comment and returns
`"executed": false` with an explicit note rather than pretending to work.

## Testing safely

```sh
bun test apps/controller/tests/pr-followup.test.ts
```

To rehearse without GitHub, POST a signed `issue_comment` payload to
`/api/github/webhook` with `X-GitHub-Event: issue_comment` and a body signed
with your `GITHUB_WEBHOOK_SECRET`. Use a test repository and an allowlist entry
for your own login.