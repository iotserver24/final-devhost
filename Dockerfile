# syntax=docker/dockerfile:1
# Sentinel controller image.
#
# Build arguments let one Dockerfile serve different environments without
# editing source:
#   BUN_VERSION        pinned runtime (keep in step with packageManager)
#   CONTROLLER_PORT    default listening port inside the image
#   INSTALL_GH_CLI     install the GitHub CLI (needed for draft PR publishing)
ARG BUN_VERSION=1.3.11
FROM oven/bun:${BUN_VERSION}

ARG INSTALL_GH_CLI=true
ARG CONTROLLER_PORT=8787

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && if [ "$INSTALL_GH_CLI" = "true" ]; then \
       curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
       && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
       && apt-get update \
       && apt-get install -y --no-install-recommends gh; \
     fi \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/vm-agent/package.json apps/vm-agent/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/notifier/package.json packages/notifier/package.json
COPY packages/remediator/package.json packages/remediator/package.json
COPY apps/sample/package.json apps/sample/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps/controller apps/controller
WORKDIR /app/apps/controller

# Runtime defaults; override with environment or compose values.
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV CONTROLLER_HOST=0.0.0.0
ENV CONTROLLER_PORT=${CONTROLLER_PORT}

# The controller runs as the image's non-root bun user where possible.
USER bun

EXPOSE ${CONTROLLER_PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${CONTROLLER_PORT}/api/auth/session" >/dev/null || exit 1

CMD ["bun", "src/server.ts"]
