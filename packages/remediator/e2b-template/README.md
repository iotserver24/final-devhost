# Nexathon E2B template source

This **tracked Dockerfile is the reproducible source** for the sandbox used by the remediator. It is a slim adaptation of the sibling Supercharge project's `sandbox/e2b-agent-template/Dockerfile` and the sibling `betacsinmamit/e2b-template/Dockerfile`; it does **not** copy their 200+ MB binaries, browser/daemon services, local `.env` files, or opaque `e2b.toml` template IDs.

The image is based on E2B's base image and pins **Bun 1.3.11** and published **Supercharge 1.3.30**. Project dependencies are installed per run from the cloned SHA with `bun install --frozen-lockfile --filter ./apps/sample`. Model/GitHub credentials are injected only at sandbox run time, never during image build.

## Build and verify

With `E2B_API_KEY` configured and the E2B CLI installed:

```sh
bun run --cwd packages/remediator template:build
E2B_REMEDIATOR_TEMPLATE=nexathon-remediator \
  SMOKE_ASSERT_PREINSTALLED=1 SMOKE_MCP_CONFIG=1 SMOKE_INSTALL_TARGET=sample \
  SMOKE_CLONE_SHA=$(git rev-parse HEAD) \
  bun run --cwd packages/remediator smoke:e2b
E2B_REMEDIATOR_TEMPLATE=nexathon-remediator \
  SMOKE_CLONE_SHA=$(git rev-parse HEAD) \
  bun run --cwd packages/remediator smoke:fixture
```

The build creates/rebuilds the account template alias `nexathon-remediator` with **8 vCPUs and 8192 MiB RAM**. E2B template builds and live smoke sandboxes incur E2B usage. The alias must be rebuilt in the E2B account for the new size to take effect: the Dockerfile and this script are the source of truth, but the hosted template is separate state. To start a new sandbox, the controller sets `E2B_REMEDIATOR_TEMPLATE=nexathon-remediator`. Another account must run the build command before use.

Do not commit a generated `e2b.toml` containing an account-specific template ID. After changing the version pins or Dockerfile, rebuild the template and repeat both smoke commands before changing the alias used by the controller.

The E2B build runner may not honor Dockerfile `ENV PATH` during `RUN` steps; version checks use absolute paths, and the remediator explicitly adds Bun/Supercharge locations to `PATH` for each command.
