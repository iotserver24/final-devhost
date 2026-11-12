# Nexathon demo script

Use the fixture mode for a truthful, repeatable rehearsal when Vercel, Slack,
or the controller is unavailable. Fixture labels remain visible in the UI.

## Judge commands

From the repository root, after `bun install`:

```sh
bun run demo:rehearsal
```

Opens the dashboard on `http://127.0.0.1:5173` with fixture incidents. The header
says **Rehearsal data**. This process does not start the controller and does not
call Vercel, GitHub, Slack, or rollback.

```sh
bun run demo:live
```

Starts the local controller and the dashboard. The script forces monitoring and
rollback **off** for the session, even if a local `.env` enables them. The header
says **Local controller**. It prints the command to start one AI remediation run:

```sh
bun run --cwd apps/controller start:run -- --incident=<incident id>
```

That run needs `NEXATHON_RUN_TOKEN` in the controller environment. Add
`--rehearsal` for placeholder activity that does not call a model. A real run
opens a draft pull request only; nothing is merged.

These two root scripts are new. `apps/controller` `start` and `start:run`, and
`packages/remediator` `demo:fix`, already existed.

## Start the dashboard

The rehearsal command above is the fixture path. To start pieces by hand:

```sh
bun install
NEXT_PUBLIC_DATA_MODE=fixtures bun run --cwd apps/dashboard dev
```

For a hand-started live controller, omit `NEXT_PUBLIC_DATA_MODE=fixtures` and set
`CONTROLLER_API_URL` in `apps/dashboard/.env` to its localhost origin. Leave
`CONTROLLER_MONITOR_ENABLED` false until a public-domain probe has been checked
against both the production hostname and the immutable deployment URL.

## Three-minute talk track

1. **Problem — 20 seconds.** “When a deployment breaks a route, the useful
   evidence is split across probes, deployment revisions, logs, and chat. This
   desk puts the evidence and the safety decision in one place.”

2. **Architecture — 35 seconds.** “The local controller probes the public
   production hostname of the allowlisted Vercel project. A private immutable
   deployment URL that answers 401 is not treated as an outage. When the public
   route really fails, the controller compares the previous deployment and
   chooses rollback or a draft fix PR. The dashboard is read-only.”

3. **Fresh regression — 60 seconds.** Select **Fresh runtime regression**.
   Point out three failed probes, the passing predecessor, the single guarded
   rollback, and the passing recovery probe. Call out that no code was merged.

4. **Persistent defect — 50 seconds.** Select **Persistent defect**. Show that
   both revisions fail, so rollback is skipped; then show the reproduction,
   passing targeted test/build, and draft PR link. The PR remains for human
   review.

5. **Safety — 15 seconds.** “Failed builds never roll back healthy
   production. Missing evidence, failed verification, sandbox errors, and
   notification failures escalate or remain visible instead of claiming
   success. After a Vercel rollback, a human may need to promote a repaired
   deployment before normal automatic assignment resumes.”

## Rehearsal checklist

- Confirm the dashboard shows `Rehearsal data` when fixtures are used.
- Open both rollback and draft-PR action links before presenting.
- Keep a screenshot of each fixture view as a backup; label it as fixture data.
- If Slack is unavailable, show the local report and say notification failure
  did not block recovery or PR creation.
- For the live run, verify the controller is bound to localhost and the Vercel
  project/token are the allowlisted demo resources.
