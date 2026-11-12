# Remediator — Anish Kumar

Bun/TypeScript package for the **fix-PR path only**. The trusted local controller decides whether to dispatch a persistent defect or broken build. This package never performs a Vercel rollback and never merges a PR.

## Implemented

- Creates a 10-minute E2B sandbox from the configured 4 GiB+ custom template, clones the allowlisted public `iotserver24/nexathon` repo at an exact 40-character SHA, uses preinstalled **Bun 1.3.11** (or installs it when using another compatible template) and runs the configured setup command.
- Runs the configured reproduction first. If it passes, the agent investigates the code and full runtime logs and adds an incident-specific regression test; the controller independently verifies that test fails against the original source and passes after the fix. Existing tests may not be weakened. Uses preinstalled verified published **Supercharge CLI 1.3.30** in the sandbox (or installs it as a fallback) (the hosted installer currently needs `SUPERCHARGE_GITHUB_REPO=iotserver24/supercharge-releases`). Configures a dedicated model provider and GitHub's remote MCP in read-only mode using a separate read-only token.
- Runs Supercharge headlessly with a prompt file, automatic tool approval **only inside E2B**, no subagents, an 18-turn cap, and a 270-second command cap. Files from GitHub, PRs and logs are untrusted inputs. Limits edited files to `apps/sample/`.
- Runs reproduction, all tests, and build again. Returns a bounded unified patch plus redacted evidence; refuses empty, binary, symlink, secret-bearing, outside-path, failed-test, or failed-build changes. Destroys the sandbox in `finally`.
- A separate **controller-only** `publishDraftPr()` revalidates the patch, clones the exact base SHA into a temporary directory, applies it, pushes `agent/incident-<id>` via a controller-only `GH_TOKEN`, and opens a **draft** PR. No write token enters E2B.

## Bun commands

From repository root:

```sh
bun install
bun run --cwd packages/remediator typecheck
bun test --cwd packages/remediator
bun run --cwd packages/remediator smoke:e2b
E2B_REMEDIATOR_TEMPLATE=nexathon-remediator \
  SMOKE_ASSERT_PREINSTALLED=1 SMOKE_MCP_CONFIG=1 \
  SMOKE_INSTALL_TARGET=sample SMOKE_CLONE_SHA=$(git rev-parse HEAD) \
  bun run --cwd packages/remediator smoke:e2b
```

The last two commands create a short-lived **real E2B sandbox** and require `E2B_API_KEY`. The extended smoke test clones the exact pushed SHA, installs only the sample workspace, runs sample tests/build, verifies the Next build output, and checks that published Supercharge parses its GitHub MCP configuration with a **dummy** token. A separate remediator-only smoke is available by omitting `SMOKE_INSTALL_TARGET=sample`. It does not authenticate to GitHub MCP, call a model, or open a PR. A full fix run also needs a sample app, a failing test, a dedicated provider key, and a read-only GitHub MCP credential.

## Deterministic fix-path rehearsal (no model key needed)

After the sample app has been merged, the following command clones that exact revision in a 4 GiB E2B sandbox, uploads a **temporary** regression test for task filtering, proves it fails, applies a test-only deterministic repair, and verifies the targeted test, all sample tests, Next build, and the safe patch boundary:

```sh
E2B_REMEDIATOR_TEMPLATE=nexathon-remediator \
  SMOKE_CLONE_SHA=$(git rev-parse origin/main) \
  bun run --cwd packages/remediator smoke:fixture
```

The source fixture is `fixtures/task-filter.repro.ts.txt`; it is copied only into the ephemeral sandbox. This rehearsal makes **no GitHub branch/PR, production change, model call, or persistent sample-app edit**. It tests the fix pipeline mechanics, **not** Supercharge's ability to produce a fix. The full AI path still needs dedicated credentials, a real controller dispatch, and an incident-specific regression test.

## Manual Supercharge fix-path demo (when dedicated credentials exist)

The controller is not required for this **isolated demonstration**. Copy `.env.example` into your own ignored local environment file (or set variables in the shell) and use a dedicated spend-limited model key, a separate read-only GitHub MCP token, and the 4 GiB+ E2B template:

```sh
bun run --cwd packages/remediator demo:fix --sha=$(git rev-parse origin/main)
# Only after reviewing the dry-run outcome; this repeats the model run and opens a draft PR:
bun run --cwd packages/remediator demo:fix --sha=$(git rev-parse origin/main) --publish
```

`demo:fix` uploads the trusted regression fixture into E2B before the baseline, rejects agent edits to that test, requires failing-before/passing-after plus all sample tests/build, and prints only a summary. Without `--publish`, it never pushes or opens a PR. With `--publish`, the **controller-side** publisher needs a repository-scoped `GH_TOKEN`; no write token enters E2B. This is a fixture-driven PR demo, **not** production incident detection or automatic rollback. The exact cloned commit must not already contain `apps/sample/tests/filter.repro.test.ts`.

## Controller integration

Ronit should add `"@nexathon/remediator": "workspace:*"` to `apps/controller/package.json` and run `bun install` at the root before importing this package. The controller owns the incident-to-request mapping and keeps its GitHub write token locally.

```ts
import { generateFixInE2B, publishDraftPr } from '@nexathon/remediator';

const request = {
  incidentId: incident.id,
  repository: 'iotserver24/nexathon',
  commitSha: incident.commitSha, // exact 40-character SHA
  evidence: incident.evidence,   // redact and bound before dispatch
  setupCommand: 'bun install --frozen-lockfile --filter ./apps/sample',
  reproduceCommand: 'bun test apps/sample/tests/repro.test.ts',
  testCommand: 'bun run --cwd apps/sample test',
  buildCommand: 'bun run --cwd apps/sample build',
};

const fix = await generateFixInE2B(request, {
  modelName: 'dedicated-model',
  modelId: process.env.REMEDIATOR_MODEL_ID!,
  baseUrl: process.env.REMEDIATOR_MODEL_BASE_URL!, // HTTPS API root, e.g. /v1
  apiBackend: 'responses', // or chat_completions/messages, matching provider
  apiKey: process.env.REMEDIATOR_MODEL_API_KEY!,
  githubReadToken: process.env.GITHUB_READ_TOKEN!,
});

if (fix.ok) {
  const pr = await publishDraftPr(request, fix); // controller machine only; GH_TOKEN required
  // Persist pr.url, notify Slack, and leave review/merge to humans.
} else {
  // Persist fix.reason + fix.message as a failed automatic attempt; never open an unverified PR.
}
```

`E2B_REMEDIATOR_TEMPLATE` is required on the controller. The default E2B base sandbox was killed (exit 137) by the sample app dependency install. This repo now contains the source at `e2b-template/Dockerfile` for our dedicated `nexathon-remediator` 4 GiB template, built and smoke-tested with sample tests/build and the deterministic fix rehearsal. Do not use the default base template for a fix run.

`setupCommand`, `reproduceCommand`, `testCommand`, and `buildCommand` must be **trusted project configuration**, not text taken from an alert, PR, or model output. `publishDraftPr` requires `GH_TOKEN` with Contents and Pull requests write access scoped to this repo; `GITHUB_READ_TOKEN` must be separate and read-only. Keep both and the provider key in local secrets, not `.env` committed to Git. GitHub MCP configuration uses `X-MCP-Readonly: true`, but the token itself should also have minimum permissions.

## Integration blockers / next steps

- Ronit must add the sample app, a reproducible failing-test fixture, and the controller's shared incident contract. Then connect the controller's `fix_pr` decision to `generateFixInE2B` and persist its result.
- Anish needs a **dedicated** model API credential and a read-only GitHub MCP token before the first full fix run. E2B sandbox creation, preinstalled Bun/Supercharge versions, sample install/build, and the deterministic fixture have been smoke-tested with the available E2B key; **the model-driven fix and PR creation are not yet end-to-end verified**.
- The published Supercharge release is currently 1.3.30 despite a newer locally built binary/docs. If the release changes, verify the exact installer asset and CLI flags before upgrading the pinned version.

## Agent transcript

Streaming JSON is parsed into public assistant messages, tool calls, redacted
inputs and results, usage, and status events. Private thought/reasoning events
and corresponding nested fields are omitted. The agent is prompted to explain
its findings, next actions, and final root cause and verification summary.
Setup, reproduction, tests, build output, changed files, and the verified diff
are included in the saved transcript. Entries over 32,000 characters carry an
explicit truncation notice; malformed and oversized protocol lines are skipped
without corrupting subsequent events.
