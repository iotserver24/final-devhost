FROM oven/bun:1.3.11
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/sample/package.json apps/sample/package.json
RUN bun install --frozen-lockfile --production
COPY apps/sample apps/sample
WORKDIR /app/apps/sample
RUN bun run build
EXPOSE 3000
CMD ["bun", "run", "start"]
