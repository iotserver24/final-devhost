FROM oven/bun:1.3.11

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/controller/package.json apps/controller/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/notifier/package.json packages/notifier/package.json
COPY packages/remediator/package.json packages/remediator/package.json
COPY apps/sample/package.json apps/sample/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps/controller apps/controller
WORKDIR /app/apps/controller
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV CONTROLLER_HOST=0.0.0.0
ENV CONTROLLER_PORT=8787
EXPOSE 8787
CMD ["bun", "src/server.ts"]
